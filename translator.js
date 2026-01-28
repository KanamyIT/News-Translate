const dictionary = {
  hello: 'привет',
  world: 'мир',
  code: 'код',
  programming: 'программирование',
  function: 'функция',
  variable: 'переменная',
  server: 'сервер',
  client: 'клиент',
  weather: 'погода'
};

function translateWord(word, direction = 'en-ru') {
  if (!word || typeof word !== 'string') return null;
  const w = word.toLowerCase().trim();

  if (direction === 'en-ru') return dictionary[w] || null;

  if (direction === 'ru-en') {
    for (const [en, ru] of Object.entries(dictionary)) {
      if (ru === w) return en;
    }
  }
  return null;
}

function translateText(text) {
  if (!text || typeof text !== 'string') return text;

  let result = text;
  const entries = Object.entries(dictionary).sort((a, b) => b[0].length - a[0].length);

  for (const [en, ru] of entries) {
    const regex = new RegExp(`\\b${en}\\b`, 'gi');
    result = result.replace(regex, (m) => (m[0] === m[0].toUpperCase() ? ru[0].toUpperCase() + ru.slice(1) : ru));
  }
  return result;
}

module.exports = { translateWord, translateText, dictionary };
