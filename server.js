const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:5000', '*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Словарь для перевода
const translator = require('./translator');

// ===================== API ENDPOINTS =====================

// 1. Перевод URL сайта
app.post('/api/translate-url', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL не предоставлен' 
            });
        }

        // Валидация URL
        const urlRegex = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
        if (!urlRegex.test(url)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Неверный формат URL' 
            });
        }

        // Загружаем страницу
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        // Очищаем скрипты и стили
        $('script').remove();
        $('style').remove();
        $('noscript').remove();

        // Получаем заголовок
        let title = $('h1').first().text() || 
                   $('title').text() || 
                   $('meta[property="og:title"]').attr('content') || 
                   'Статья';

        // Получаем контент
        let content = '';
        
        // Приоритет: article > main > section > div.content
        const contentSelector = $('article').length ? 'article' : 
                               $('main').length ? 'main' : 
                               $('section').length ? 'section' : 
                               'body';

        $(contentSelector).find('p').each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > 30) {
                content += '<p>' + text + '</p>';
            }
        });

        // Если контента нет, берем из div
        if (!content) {
            $('body').find('div').each((i, el) => {
                if ($(el).children().length === 0) {
                    const text = $(el).text().trim();
                    if (text.length > 50) {
                        content += '<p>' + text + '</p>';
                    }
                }
            });
        }

        // Переводим заголовок
        const translatedTitle = translator.translateText(title);

        // Переводим контент
        const translatedContent = translator.translateText(content);

        res.json({
            success: true,
            title: translatedTitle,
            content: translatedContent,
            url: url
        });

    } catch (error) {
        console.error('URL Error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка при загрузке сайта: ' + (error.message || 'Неизвестная ошибка')
        });
    }
});

// 2. Перевод текста
app.post('/api/translate-text', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ 
                success: false, 
                error: 'Текст не предоставлен' 
            });
        }

        const translatedText = translator.translateText(text);

        res.json({
            success: true,
            original: text,
            translated: translatedText
        });

    } catch (error) {
        console.error('Translate Text Error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка при переводе текста'
        });
    }
});

// 3. Перевод слова
app.post('/api/translate-word', (req, res) => {
    try {
        const { word, direction } = req.body;

        if (!word) {
            return res.status(400).json({ 
                success: false, 
                error: 'Слово не предоставлено' 
            });
        }

        const translation = translator.translateWord(word, direction);

        res.json({
            success: !!translation,
            word: word,
            translation: translation || 'Не найдено',
            direction: direction
        });

    } catch (error) {
        console.error('Translate Word Error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка при переводе слова'
        });
    }
});

// 4. Получение погоды
app.get('/api/weather', async (req, res) => {
    try {
        const response = await axios.get('https://wttr.in/?format=j1', {
            timeout: 5000
        });

        const data = response.data;
        const current = data.current_condition;
        const location = data.nearest_area;

        res.json({
            success: true,
            temp: current.temp_C,
            condition: current.lang_ru ? current.lang_ru.value : 'Облачно',
            humidity: current.humidity,
            windspeed: current.windspeed_kmph,
            location: location.areaName.value,
            country: location.country.value
        });

    } catch (error) {
        console.error('Weather Error:', error.message);
        // Возвращаем mock данные если ошибка
        res.json({
            success: true,
            temp: 15,
            condition: 'Облачно',
            humidity: 65,
            windspeed: 5,
            location: 'Москва',
            country: 'Россия'
        });
    }
});

// 5. Получение статей по категориям
app.get('/api/articles/:category', (req, res) => {
    try {
        const { category } = req.params;

        const articles = {
            programming: [
                { title: 'JavaScript для начинающих', url: 'https://www.w3schools.com/js/', category: 'programming' },
                { title: 'Python основы', url: 'https://www.w3schools.com/python/', category: 'programming' },
                { title: 'HTML и CSS руководство', url: 'https://www.w3schools.com/html/', category: 'programming' },
                { title: 'React документация', url: 'https://react.dev/', category: 'programming' },
                { title: 'Node.js гайд', url: 'https://nodejs.org/en/docs/', category: 'programming' }
            ],
            history: [
                { title: 'Древний Рим', url: 'https://www.britannica.com/place/ancient-rome', category: 'history' },
                { title: 'Мировая история', url: 'https://www.britannica.com/history', category: 'history' },
                { title: 'Вторая мировая война', url: 'https://www.britannica.com/event/World-War-II', category: 'history' },
                { title: 'Древний Египет', url: 'https://www.britannica.com/place/ancient-egypt', category: 'history' },
                { title: 'Средние века', url: 'https://www.britannica.com/event/Middle-Ages', category: 'history' }
            ],
            games: [
                { title: 'История видеоигр', url: 'https://www.britannica.com/technology/video-game', category: 'games' },
                { title: 'Game Design Patterns', url: 'https://gameprogrammingpatterns.com/', category: 'games' },
                { title: 'Unreal Engine', url: 'https://www.unrealengine.com/', category: 'games' },
                { title: 'Киберспорт', url: 'https://www.britannica.com/topic/esports', category: 'games' },
                { title: 'Game Development', url: 'https://www.gamedev.net/', category: 'games' }
            ],
            cinema: [
                { title: 'История кинематографа', url: 'https://www.britannica.com/technology/motion-picture', category: 'cinema' },
                { title: 'Кинематография', url: 'https://www.britannica.com/art/film', category: 'cinema' },
                { title: 'Режиссура фильмов', url: 'https://www.britannica.com/art/film-directing', category: 'cinema' },
                { title: 'Киноиндустрия', url: 'https://www.britannica.com/topic/Hollywood', category: 'cinema' },
                { title: 'Мировое кино', url: 'https://www.britannica.com/art/world-cinema', category: 'cinema' }
            ]
        };

        const categoryArticles = articles[category] || [];

        res.json({
            success: true,
            category: category,
            count: categoryArticles.length,
            articles: categoryArticles
        });

    } catch (error) {
        console.error('Articles Error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка при получении статей'
        });
    }
});

// 6. Health Check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// 7. Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 обработка
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint не найден' 
    });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Внутренняя ошибка сервера'
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
    console.log(`📡 API доступен на http://localhost:${PORT}/api`);
    console.log(`🌐 Открой браузер на http://localhost:${PORT}`);
});
