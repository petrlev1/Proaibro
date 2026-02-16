const STORAGE_KEYS = ['pageExtractedTitle', 'pageExtractedText', 'pageExtractedUrl'];
const CHATS_KEY = 'proaibro_chats';
const CHAT_ORDER_KEY = 'proaibro_chat_order';
const PRIVATE_CHAT_KEY = 'proaibro_private_messages';
const PRIVATE_MODE_KEY = 'proaibro_private_mode';

function getEl(id) {
  return document.getElementById(id);
}

let apiKey = null;
let currentChatId = null;
let isPrivateMode = false;

async function loadApiKey() {
  try {
    const response = await fetch(chrome.runtime.getURL('Settings.json'));
    const settings = await response.json();
    apiKey = settings.openrouter_api_key;
  } catch (err) {
    console.error('Failed to load API key:', err);
    return null;
  }
}

function createChatId() {
  return 'chat-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

async function getChats() {
  const r = await chrome.storage.local.get([CHATS_KEY]);
  return r[CHATS_KEY] || {};
}

async function getChatOrder() {
  const r = await chrome.storage.local.get([CHAT_ORDER_KEY]);
  return r[CHAT_ORDER_KEY] || [];
}

async function saveChatToLocal(chatId, chat) {
  const chats = await getChats();
  chats[chatId] = chat;
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
  const order = await getChatOrder();
  if (!order.includes(chatId)) {
    order.unshift(chatId);
    await chrome.storage.local.set({ [CHAT_ORDER_KEY]: order });
  }
}

async function appendMessageToLocalChat(chatId, role, content, titleSnippet) {
  const chats = await getChats();
  let chat = chats[chatId];
  if (!chat) {
    chat = { id: chatId, createdAt: Date.now(), title: titleSnippet || 'Новый чат', messages: [] };
  }
  chat.messages.push({ role, content, timestamp: Date.now() });
  if (titleSnippet && !chat.title) chat.title = titleSnippet;
  chats[chatId] = chat;
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
  let order = await getChatOrder();
  if (!order.includes(chatId)) {
    order.unshift(chatId);
    await chrome.storage.local.set({ [CHAT_ORDER_KEY]: order });
  }
}

async function getPrivateMessages() {
  const r = await chrome.storage.session.get([PRIVATE_CHAT_KEY]);
  return r[PRIVATE_CHAT_KEY] || [];
}

async function appendPrivateMessage(role, content) {
  const messages = await getPrivateMessages();
  messages.push({ role, content, timestamp: Date.now() });
  await chrome.storage.session.set({ [PRIVATE_CHAT_KEY]: messages });
}

async function sendQueryToModel(text, userQuery) {
  if (!apiKey) {
    await loadApiKey();
    if (!apiKey) throw new Error('API ключ не найден');
  }
  const userContent = `${userQuery.trim()}\n\nТекст:\n${text.substring(0, 50000)}`;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': chrome.runtime.getURL('viewer.html'),
      'X-Title': 'Proaibro'
    },
    body: JSON.stringify({
      model: 'qwen/qwen3-30b-a3b-thinking-2507',
      messages: [
        { role: 'system', content: 'Ты помощник. Выполняй запрос пользователя относительно приведённого текста. Отвечай на русском языке по существу запроса.' },
        { role: 'user', content: userContent }
      ],
      temperature: 0.7,
      max_tokens: 2000
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }
  const data = await response.json();
  return data.choices[0]?.message?.content || 'Нет ответа от модели';
}

async function loadPageFromStorage() {
  const data = await chrome.storage.session.get(STORAGE_KEYS);
  getEl('textContent').textContent = data.pageExtractedText || '';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderMessages(messages) {
  const container = getEl('messagesContainer');
  container.innerHTML = '';
  if (!messages || messages.length === 0) return;
  messages.forEach(msg => {
    const block = document.createElement('div');
    block.className = 'message-block message-' + msg.role;
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = msg.role === 'user' ? 'Вы' : 'Помощник';
    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = escapeHtml(msg.content).replace(/\n/g, '<br>');
    block.appendChild(label);
    block.appendChild(body);
    container.appendChild(block);
  });
  container.scrollTop = container.scrollHeight;
}

async function loadChat(chatId) {
  const chats = await getChats();
  const chat = chats[chatId];
  if (!chat) return;
  currentChatId = chatId;
  isPrivateMode = false;
  await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: false });
  renderMessages(chat.messages);
  updateModeIndicator();
  renderHistoryList();
  try {
    window.location.hash = chatId;
  } catch (_) {}
}

async function newChat() {
  currentChatId = createChatId();
  isPrivateMode = false;
  await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: false });
  await chrome.storage.session.remove([PRIVATE_CHAT_KEY]);
  renderMessages([]);
  updateModeIndicator();
  renderHistoryList();
  getEl('queryInput').value = '';
  try { window.location.hash = ''; } catch (_) {}
}

async function privateChat() {
  currentChatId = null;
  isPrivateMode = true;
  await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: true, [PRIVATE_CHAT_KEY]: [] });
  renderMessages([]);
  updateModeIndicator();
  renderHistoryList();
  getEl('queryInput').value = '';
  try { window.location.hash = ''; } catch (_) {}
}

function updateModeIndicator() {
  const el = getEl('chatModeIndicator');
  if (isPrivateMode) {
    el.textContent = 'Приватный чат (не сохраняется)';
    el.className = 'chat-mode-indicator private';
  } else {
    el.textContent = 'Обычный чат (сохраняется)';
    el.className = 'chat-mode-indicator normal';
  }
}

async function renderHistoryList() {
  const list = getEl('historyList');
  list.innerHTML = '';
  if (isPrivateMode) return;
  const order = await getChatOrder();
  const chats = await getChats();
  order.slice(0, 50).forEach(chatId => {
    const chat = chats[chatId];
    if (!chat) return;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'history-link' + (chatId === currentChatId ? ' current' : '');
    const title = chat.title || new Date(chat.createdAt).toLocaleString('ru');
    const date = new Date(chat.createdAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    link.textContent = date + ' — ' + (title.length > 40 ? title.slice(0, 40) + '…' : title);
    link.title = title;
    link.addEventListener('click', () => loadChat(chatId));
    list.appendChild(link);
  });
}

async function initFromStorage() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  if (hash && hash.startsWith('chat-')) {
    const chats = await getChats();
    if (chats[hash]) {
      currentChatId = hash;
      isPrivateMode = false;
      await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: false });
      renderMessages(chats[hash].messages);
      updateModeIndicator();
      renderHistoryList();
      return;
    }
  }
  const session = await chrome.storage.session.get([PRIVATE_MODE_KEY, PRIVATE_CHAT_KEY]);
  if (session[PRIVATE_MODE_KEY] && Array.isArray(session[PRIVATE_CHAT_KEY])) {
    isPrivateMode = true;
    currentChatId = null;
    renderMessages(session[PRIVATE_CHAT_KEY]);
  } else {
    isPrivateMode = false;
    currentChatId = createChatId();
    renderMessages([]);
  }
  updateModeIndicator();
  renderHistoryList();
}

getEl('newChatBtn').addEventListener('click', newChat);
getEl('privateChatBtn').addEventListener('click', privateChat);

document.getElementById('sendBtn').addEventListener('click', async () => {
  const btn = getEl('sendBtn');
  const queryInput = getEl('queryInput');
  const userQuery = queryInput.value.trim();
  if (!userQuery) {
    queryInput.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Обработка...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      btn.textContent = 'Ошибка: нет вкладки';
      btn.disabled = false;
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title || 'Без названия',
        text: document.body ? document.body.innerText : ''
      })
    });

    if (!results?.[0]?.result) {
      btn.textContent = 'Не удалось прочитать страницу (chrome://?)';
      btn.disabled = false;
      return;
    }

    const { title, text } = results[0].result;
    if (!text || text.trim().length === 0) {
      btn.textContent = 'Данных пока нет';
      btn.disabled = false;
      return;
    }

    await chrome.storage.session.set({
      pageExtractedTitle: title,
      pageExtractedText: text,
      pageExtractedUrl: tab.url || ''
    });
    await loadPageFromStorage();

    getEl('summaryLoading').style.display = 'block';
    let responseText;
    try {
      responseText = await sendQueryToModel(text, userQuery);
    } catch (err) {
      console.error('Query failed:', err);
      responseText = 'Ошибка: ' + err.message;
    }
    getEl('summaryLoading').style.display = 'none';

    const titleSnippet = userQuery.slice(0, 50);

    if (isPrivateMode) {
      await appendPrivateMessage('user', userQuery);
      await appendPrivateMessage('assistant', responseText);
      const messages = await getPrivateMessages();
      renderMessages(messages);
    } else {
      if (!currentChatId) currentChatId = createChatId();
      await appendMessageToLocalChat(currentChatId, 'user', userQuery, titleSnippet);
      await appendMessageToLocalChat(currentChatId, 'assistant', responseText);
      const chats = await getChats();
      renderMessages((chats[currentChatId] || {}).messages || []);
      renderHistoryList();
    }

    queryInput.value = '';
  } catch (err) {
    getEl('summaryLoading').style.display = 'none';
  }
  btn.textContent = 'Отправить запрос';
  btn.disabled = false;
});

loadApiKey();
loadPageFromStorage();
initFromStorage();
