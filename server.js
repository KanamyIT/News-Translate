const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Простой переводчик (используем API или локальный словарь)
const translator = require('./translator.js');

// API для перевода URL
app.post('/api/translate-url', async (req, res) => {
    try {
        const { url } = req.body;
        
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        // Получаем заголовок
        let title = $('title').text() || $('h1').first().text() || 'Документ';
        
        // Переводим заголовок
        const translatedTitle = await translator.translateText(title);

        // Извлекаем контент, исключая скрипты и стили
        $('script').remove();
        $('style').remove();
        $('noscript').remove();

        // Собираем текст
        let content = '';
        $('body').find('*').each((i, el) => {
            if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.name)) return;
            
            const text = $(el).clone().children().remove().end().text().trim();
            if (text && text.length > 2) {
                content += text + ' ';
            }
        });

        // Переводим контент частями
        const translatedContent = await translator.translateLargeText(content);

        res.json({
            success: true,
            originalTitle: translatedTitle,
            content: `<h2>${translatedTitle}</h2><p>${translatedContent}</p>`
        });
    } catch (error) {
        res.json({
            success: false,
            error: 'Ошибка при загрузке сайта: ' + error.message
        });
    }
});

// API для перевода текста
app.post('/api/translate-text', async (req, res) => {
    try {
        const { text } = req.body;
        const translatedText = await translator.translateText(text);
        
        res.json({
            success: true,
            translatedText: translatedText
        });
    } catch (error) {
        res.json({
            success: false,
            error: 'Ошибка при переводе: ' + error.message
        });
    }
});

// API для перевода слова
app.post('/api/translate-word', async (req, res) => {
    try {
        const { word, direction } = req.body;
        const translation = translator.translateWord(word, direction);
        
        if (translation) {
            res.json({
                success: true,
                translation: translation
            });
        } else {
            res.json({
                success: false,
                translation: 'Слово не найдено'
            });
        }
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// API для погоды
app.get('/api/weather', async (req, res) => {
    try {
        // Используем бесплатный API OpenWeatherMap
        const API_KEY = process.env.WEATHER_API_KEY || 'demo';
        const response = await axios.get(
            `https://api.openweathermap.org/data/2.5/weather?q=Moscow&units=metric&lang=ru&appid=${API_KEY}`
        );

        const data = response.data;
        
        res.json({
            success: true,
            temp: data.main.temp,
            description: data.weather[0].description,
            humidity: data.main.humidity,
            wind: data.wind.speed
        });
    } catch (error) {
        // Возвращаем demo данные если ошибка
        res.json({
            success: true,
            temp: 15,
            description: 'Облачно',
            humidity: 65,
            wind: 3.5
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
