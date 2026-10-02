/* =====================================================================
   PAINEL DE GESTÃO ESPOSENDE · configuração da instalação
   Preencha com os dados do projeto Supabase (Project Settings → API / API Keys).
   Com SUPABASE_URL vazio, o painel funciona no modo local (dados só neste navegador).
   Na Vercel este arquivo é gerado a partir das variáveis de ambiente (gerar-config.js).
   ===================================================================== */
window.PAINEL_CONFIG = {
  SUPABASE_URL: '',                    // ex.: 'https://abcdefghijklmnop.supabase.co'
  SUPABASE_ANON_KEY: '',               // chave pública: "anon public" ou "Publishable key" (sb_publishable_…). NUNCA a service_role/secret.
  LOGIN_DOMINIO: 'esposende.com.br',   // domínio técnico dos logins (CPF@domínio). Nenhum e-mail é enviado.
};
