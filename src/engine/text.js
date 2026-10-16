// "Eu QUERO!!! 🔥" -> "eu quero"
export const normalizeText = (s = '') =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function matches(text, keywords, mode = 'contains') {
  if (mode === 'any') return true;
  const t = normalizeText(text);
  return keywords.some((k) => {
    const kw = normalizeText(k);
    if (!kw) return false;
    if (mode === 'exact') return t === kw;
    return ` ${t} `.includes(` ${kw} `); // palavra inteira, não pedaço ("quero" não casa "queroquero")
  });
}
