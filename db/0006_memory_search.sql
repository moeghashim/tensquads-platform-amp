-- The search of the memory (docs/ARCHITECTURE.md, sections 7.1 and 7.2, requirements M5, M6 and M12).
-- Our code makes the text regular first. Petra writes to_tsvector('simple', <regular text>) to each search column.
-- The notes get a search column too, for the read list entry "memory/notes".

ALTER TABLE notes ADD COLUMN search tsvector;

CREATE INDEX facts_search ON facts USING gin (search);
CREATE INDEX notes_search ON notes USING gin (search);
