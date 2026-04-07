CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(
  title,
  body_plaintext,
  tokenize = 'trigram'
);
