// Настройки входа через Яндекс. Секретов здесь нет.
// YANDEX_CLIENT_ID: ID приложения с oauth.yandex.ru (Redirect URI = адрес сайта).
// API_BASE: адрес API Gateway в Яндекс Облаке, без слэша на конце. Шлюз moy-chat-auth.
export const YANDEX_CLIENT_ID = '6a6db4c2f5ae42deb60d63ec5c1f7355';
export const API_BASE = 'https://d5du1fva82lh827rqls4.764nr5vy.apigw.yandexcloud.net';
// Публичный VAPID-ключ для Web Push (стандарт, push-сервисы Mozilla, Google, Apple).
// Приватная часть лежит только в переменной VAPID_PRIVATE_KEY функции Яндекс Облака, сюда её не класть.
// Пока пусто, кнопка уведомлений просто не показывается.
export const VAPID_KEY = 'BIVRzI6Ckt8foA8VG190IDOB11-FZDHwMAhtWmvo3SAgfMy7bJgJlgwjYbtCNcPYbh8QtzcrOeqtdPASBQBqU8I';
