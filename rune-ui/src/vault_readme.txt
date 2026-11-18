lattice vault export

pages/    every page you wrote, as a plain file named for its path and kind.
          Generated folder indexes are left out: the store rebuilds them from
          the folder itself, so they come back when their folder does.
know/     every memory, one file per key.
know.json the memories again, in the format /know-import reads.
share.json  the share mode of every non-private page (path -> shared|clearweb).
names.json  the display name of every page or folder that was named with
          capitals or spaces (path -> the name shown in the tree).
sensitive.json  every page or folder marked sensitive (a list of paths).
manifest.json  how many pages and memories the export meant to write, and
          anything it could not read.

To put it all back, use "restore vault" in Settings and pick this file. Pages
go back to the paths they came from, the memories go back with their tags and
dates, and any shared or public pages are re-shared once you confirm the list. Anything already there is
overwritten, and the version being replaced stays in that page's history. An
archive with no share.json restores everything private.

Nothing here needs lattice to read. The pages are plain files, so grep, an
editor, or git will do if you only want to look.
