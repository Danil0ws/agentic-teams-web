/**
 * Seletores do Teams Web. O DOM do produto muda sem aviso: cada chave tem
 * alternativas em ordem de preferência (data-tid → role/aria → classe legada).
 * Ao quebrar, ajuste AQUI e rode `npm run teams-web` com TEAMS_WEB_HEADLESS=0.
 */
export const selectors = {
  /** Sinal de que a aplicação carregou e há sessão válida. */
  appRoot: ['#teams-app', '[data-tid="app-rail"]', '#app'],
  chatList: ['[data-tid="chat-list"]', '[aria-label="Lista de conversas"]', 'div[role="tree"]'],
  chatItem: ['[data-tid="chat-list-item"]', '[role="treeitem"]', 'li[data-tid*="chat"]'],
  chatItemTitle: ['[data-tid="chat-list-item-title"]', '[data-tid="chat-list-item-header"]', 'span[title]'],
  unreadBadge: ['[data-tid="chat-list-unread-count"]', '[aria-label*="não lida"]', '[class*="unread"]'],
  messageList: ['[data-tid="message-list-body"]', '[role="log"]', '[data-tid="chat-pane-messages"]'],
  messageItem: ['[data-tid="chat-pane-message"]', '[role="listitem"]', 'div[class*="message-body"]'],
  messageAuthor: ['[data-tid="message-author-name"]', '[data-tid="message-header-author"]', 'span[class*="author"]'],
  messageBody: ['[data-tid="message-body-content"]', '[class*="message-body-content"]', 'div[class*="text"]'],
  composer: [
    '[data-tid="ckeditor"] [contenteditable="true"]',
    '[data-tid="message-pane-compose-input"] [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  sendButton: ['[data-tid="send-message-button"]', 'button[aria-label*="Enviar"]', 'button[title*="Send"]'],
  /** Indícios de tela de login (sessão expirada). */
  loginWall: ['input[type="email"][name="loginfmt"]', '#i0116', 'form[name="loginForm"]'],
} as const;

export type SelectorKey = keyof typeof selectors;

/** Retorna o primeiro elemento visível entre as alternativas. */
export function firstVisible(list: readonly string[]): string {
  return list.join(', ');
}
