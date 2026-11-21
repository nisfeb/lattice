//! Requests answered one after another, none dropped. Rune's `Latest`
//! keeps only the newest request: a second one drops the first one's
//! answer, and one not yet started never runs. That is right for a read,
//! where only the newest answer matters. It is wrong for a change sent
//! to the ship: a page renamed there and not here, a new key whose
//! secret is shown once and never seen. Changes go through this.

use rune::Latest;
use std::collections::VecDeque;
use std::sync::Mutex;

type Job<T> = Box<dyn FnOnce() -> T + Send>;

struct Turn<T> {
    /// A request is running, or its answer has landed and is not yet taken.
    busy: bool,
    wait: VecDeque<Job<T>>,
}

/// A queue of requests over one `Latest`: each is started when the one
/// before it has been answered and its answer taken.
pub struct InTurn<T: Send + 'static> {
    req: Latest<T>,
    turn: Mutex<Turn<T>>,
}

impl<T: Send + 'static> Default for InTurn<T> {
    fn default() -> Self {
        InTurn { req: Latest::default(), turn: Mutex::new(Turn { busy: false, wait: VecDeque::new() }) }
    }
}

impl<T: Send + 'static> InTurn<T> {
    pub fn set_waker(&self, waker: rune::Waker) {
        self.req.set_waker(waker);
    }

    /// Asks for `work(input)` off the main thread, after every request made before it.
    pub fn request<K: Send + 'static>(&self, input: K, work: impl FnOnce(K) -> T + Send + 'static) {
        let job: Job<T> = Box::new(move || work(input));
        let mut turn = self.turn.lock().unwrap_or_else(|e| e.into_inner());
        if turn.busy {
            turn.wait.push_back(job);
        } else {
            turn.busy = true;
            self.req.request((), move |()| job());
        }
    }

    /// The oldest request's answer, once. Taking it starts the next request.
    pub fn take(&self) -> Option<T> {
        let got = self.req.take();
        let mut turn = self.turn.lock().unwrap_or_else(|e| e.into_inner());
        // a request that ended with no answer is one that panicked: it is passed over, or it would hold every request after it for the rest of the session
        let ended = got.is_some() || (turn.busy && !self.req.is_pending());
        if ended {
            match turn.wait.pop_front() {
                Some(job) => self.req.request((), move |()| job()),
                None => turn.busy = false,
            }
        }
        got
    }

    /// Whether any request is running or waiting, or an answer is not yet taken.
    pub fn is_pending(&self) -> bool {
        self.turn.lock().unwrap_or_else(|e| e.into_inner()).busy
    }

    /// Lets go of every request and any answer not yet taken. One already running finishes, and its answer never lands.
    pub fn cancel(&self) {
        let mut turn = self.turn.lock().unwrap_or_else(|e| e.into_inner());
        turn.wait.clear();
        turn.busy = false;
        self.req.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_for<T: Send + 'static>(q: &InTurn<T>) -> T {
        for _ in 0..500 {
            if let Some(v) = q.take() {
                return v;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("no answer");
    }

    #[test]
    fn every_request_is_answered_in_the_order_it_was_made() {
        let q: InTurn<u32> = InTurn::default();
        let ran = std::sync::Arc::new(Mutex::new(Vec::new()));
        for n in 1..=5u32 {
            let ran = ran.clone();
            q.request(n, move |n| {
                ran.lock().unwrap().push(n);
                n * 10
            });
        }
        assert!(q.is_pending());
        // the second is not started until the first is taken
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(*ran.lock().unwrap(), [1]);
        let got: Vec<u32> = (0..5).map(|_| wait_for(&q)).collect();
        assert_eq!(got, [10, 20, 30, 40, 50]);
        assert_eq!(*ran.lock().unwrap(), [1, 2, 3, 4, 5]);
        assert!(!q.is_pending() && q.take().is_none());
    }

    #[test]
    fn a_request_that_panics_does_not_hold_the_ones_after_it() {
        let q: InTurn<u32> = InTurn::default();
        q.request(1u32, |_| panic!("a fault in the work"));
        q.request(2u32, |n| n);
        assert_eq!(wait_for(&q), 2);
        assert!(!q.is_pending());
    }

    #[test]
    fn cancel_lets_go_of_what_waits() {
        let q: InTurn<u32> = InTurn::default();
        q.request(1u32, |n| n);
        q.request(2u32, |n| n);
        q.cancel();
        assert!(!q.is_pending());
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(q.take().is_none());
        // and it is of use again
        q.request(3u32, |n| n);
        assert_eq!(wait_for(&q), 3);
    }
}
