/**
 * Mail is a modular interface. Only the console transport exists today: emails are written to the server
 * log and NOT delivered. Plug a real provider (SMTP, Resend, SES...) by implementing `Transport`.
 */
export type Mail = { to: string; subject: string; text: string };
export type Transport = (mail: Mail) => Promise<{ delivered: boolean }>;

const consoleTransport: Transport = async (m) => {
  console.log(`[mail:console] to=${m.to} subject="${m.subject}"\n${m.text}`);
  return { delivered: false };
};
let transport: Transport = consoleTransport;
export const setMailTransport = (t: Transport) => { transport = t; };
export const sendMail = (m: Mail) => transport(m);
export const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const exposeDevLinks = () => process.env.EXPOSE_DEV_LINKS === '1' && process.env.NODE_ENV !== 'production';
