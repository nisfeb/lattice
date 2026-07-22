"""The projection seam: a Node view of one grubbery app's tree, plus the
Projection ABC the core drives. Everything app-specific (kinds, wrap/unwrap,
which route writes) lives in a subclass; the core never names any of it.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass


class ProjectionError(Exception):
    """An app write/read failed. `errno` maps it to a FUSE return in the core."""
    def __init__(self, errno_, msg=""):
        super().__init__(msg)
        self.errno = errno_


@dataclass(frozen=True)
class Node:
    """One filesystem-visible page/folder. `rel` is the projection key (no ext)."""
    rel: str            # "notes/todo"  projection path, no leading slash; "" = root
    is_dir: bool        # a plain folder (no editable source)
    is_page: bool       # has editable source; MAY also parent children
    kind: str           # md|gmi|html|text|js|css|hoon|index   ("" for a pure dir)
    size: int           # byte length of the editable body (0 for a pure dir)
    mtime: float        # unix seconds
    readonly: bool      # generated %index pages
    broken: bool = False


class Projection(ABC):
    # kind<->ext policy. Shared for lattice; another grubbery app overrides.
    EXT_OF_KIND = {"md": "md", "gmi": "gmi", "html": "html", "text": "txt",
                   "js": "js", "css": "css", "hoon": "hoon", "index": "md"}
    KIND_OF_EXT = {"md": "md", "gmi": "gmi", "html": "html", "txt": "text",
                   "js": "js", "css": "css", "hoon": "hoon"}

    # lifecycle
    @abstractmethod
    def connect(self): ...
    @abstractmethod
    def close(self): ...

    # reads
    @abstractmethod
    def list(self):
        """Whole tree, one call -> list[Node]."""
    @abstractmethod
    def read(self, rel):
        """(body_bytes, mtime) for one page."""
    @abstractmethod
    def errors(self, rel):
        """Latest evaluator error text for a page; '' = clean."""

    # writes (MUST go through the app's action; a raw grub write is illegal)
    @abstractmethod
    def write(self, rel, kind, data, *, create): ...
    @abstractmethod
    def mkdir(self, rel): ...
    @abstractmethod
    def delete(self, rel): ...
    @abstractmethod
    def move(self, src, dst):
        """Emulated read+create+delete; no server rename exists."""

    # naming
    def ext_for_kind(self, kind):
        return self.EXT_OF_KIND.get(kind, "hoon")

    def kind_for_ext(self, ext):
        return self.KIND_OF_EXT.get(ext, "hoon")

    # freshness
    @abstractmethod
    def watch(self, on_change):
        """Block, calling on_change(rel|None) when the tree changes externally."""
