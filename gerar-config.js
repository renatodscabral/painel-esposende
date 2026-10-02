/* Vercel: gera o config.js a partir das variáveis de ambiente do projeto
   (Settings → Environment Variables: SUPABASE_URL, SUPABASE_ANON_KEY e, opcional, LOGIN_DOMINIO). */
const fs = require('fs');
const e = process.env;
const cfg = { SUPABASE_URL: e.SUPABASE_URL || '', SUPABASE_ANON_KEY: e.SUPABASE_ANON_KEY || '', LOGIN_DOMINIO: e.LOGIN_DOMINIO || 'esposende.com.br' };
const papel = k => { try { return JSON.parse(Buffer.from(k.split('.')[1], 'base64').toString()).role; } catch { return ''; } };
if (/^sb_secret_/.test(cfg.SUPABASE_ANON_KEY) || papel(cfg.SUPABASE_ANON_KEY) === 'service_role') { console.error('SUPABASE_ANON_KEY parece ser a chave secreta (service_role). Use a chave pública (anon / publishable).'); process.exit(1); }
fs.writeFileSync('config.js', '/* gerado no build da Vercel */\nwindow.PAINEL_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n');
console.log('config.js gerado para', cfg.SUPABASE_URL || '(modo local)');
