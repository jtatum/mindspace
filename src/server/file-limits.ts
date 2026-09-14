export const MAX_PAPER_TEXT_CHARACTERS = 2_000_000;
// A UTF-16 code unit needs at most three UTF-8 bytes (a surrogate pair
// needs four bytes for two units). Readers must accept every cached output,
// including existing CJK-heavy extractions produced before this limit changed.
export const MAX_SHARED_TEXT_BYTES = MAX_PAPER_TEXT_CHARACTERS * 3;
