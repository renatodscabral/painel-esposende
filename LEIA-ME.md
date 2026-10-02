# Painel de Gestão Esposende — v15

Servidor web estático (intranet ou Vercel) + banco compartilhado **Supabase** + integrações externas (CNPJ, IA, armazenamento de PDFs).

## Conteúdo da pasta
| Arquivo | Para quê |
|---|---|
| `index.html`, `fcx.html` | o painel |
| `libs/` | bibliotecas locais (planilhas, gráficos, PDF, Supabase): funcionam sem CDN |
| `config.js` | **endereço e chave pública do Supabase** (você preenche) |
| `supabase/instalar.sql` | script que prepara o banco (tabela, regras de acesso, tempo real, bucket de PDFs) |
| `gerar-config.js`, `vercel.json` | só para a Vercel: gera o `config.js` a partir das variáveis de ambiente |

Sem `SUPABASE_URL` no `config.js`, o painel roda no **modo local** (dados só naquele navegador), como na v14.

---

## 1. Criar o projeto no Supabase (plano gratuito)
1. Acesse **supabase.com** → *Start your project* → entre com GitHub ou e-mail.
2. *New project*:
   - **Name:** `painel-esposende`.
   - **Database password:** gere uma senha forte e guarde no cofre de senhas. O painel não usa essa senha.
   - **Region:** *South America (São Paulo)*.
   - Plano *Free*.
3. Aguarde o projeto ficar pronto (1 a 2 minutos).

## 2. Preparar o banco
1. Menu lateral **SQL Editor** → *New query*.
2. Abra `supabase/instalar.sql`, copie **tudo**, cole e clique em **Run**. O resultado esperado é "Success. No rows returned".
   - Pode rodar de novo em versões futuras: o script atualiza as regras e não apaga dados.

## 3. Ajustar o login (Authentication)
1. **Authentication → Sign In / Providers → Email**:
   - **Confirm email: DESLIGADO.** Os logins são `CPF@esposende.com.br`, endereços técnicos que nunca recebem e-mail.
   - **Allow new users to sign up: LIGADO.** É assim que o Master cria o login de cada funcionário. Quem se cadastrar por fora não vê nada: o acesso depende da liberação na Gestão de Acessos.
2. **Authentication → Rate Limits**: aumente o limite de *sign-ups and sign-ins* (o padrão é baixo). Toda a loja sai pelo mesmo IP da internet; no padrão, um turno inteiro entrando ao mesmo tempo pode ser barrado. Sugestão: 300 por 5 minutos.
3. Não mude a regra de senha mínima: a senha inicial é o CPF (11 dígitos). A senha forte é exigida pelo próprio painel na troca obrigatória.

## 4. Copiar as chaves para o painel
1. **Project Settings → API Keys** (ou o botão **Connect** no topo). Copie:
   - **Project URL**, por exemplo `https://abcdefghijklmnop.supabase.co`;
   - **Publishable key** (`sb_publishable_…`) ou a chave legada **anon public**.
2. **Nunca use a `secret` / `service_role`.** Ela ignora todas as regras de acesso.
3. Preencha o `config.js`:
   ```js
   window.PAINEL_CONFIG = {
     SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
     SUPABASE_ANON_KEY: 'sb_publishable_xxxxxxxx',
     LOGIN_DOMINIO: 'esposende.com.br',
   };
   ```
4. Sobre o `LOGIN_DOMINIO`:
   - É só um sufixo técnico dos logins. Defina uma vez e **não troque depois**, senão os logins existentes deixam de bater.
   - Se o Supabase recusar o domínio ("email address invalid"), use o domínio real da empresa.

### Na Vercel
- Suba esta pasta para um repositório e importe na Vercel (*Framework preset: Other*).
- Em *Settings → Environment Variables*, crie `SUPABASE_URL`, `SUPABASE_ANON_KEY` e, se quiser, `LOGIN_DOMINIO`.
- O `vercel.json` já manda rodar `node gerar-config.js` no build, que escreve o `config.js`.

### Na intranet
Copie a pasta para o servidor (IIS, Apache, Nginx) e edite o `config.js` ali.

## 5. Primeiro acesso
1. Abra o painel: aparece a **Configuração inicial**. Crie o Master com nome, CPF e senha forte.
2. **Menu Backup → Restaurar** com o backup da versão anterior (opcional).
   - O backup da v15 inclui todas as coleções.
   - O da v13 (claude.ai) traz lojas, equipe, PDI, salários, configurações e FCX. Contratos e dados da Retaguarda precisam ser recadastrados ou reimportados.
3. **Módulo 1:** cadastre o **CPF** de cada funcionário.
4. **Gestão de Acessos:** ative os funcionários e defina a matriz Ler / Modificar / Excluir.
   - O login é o CPF e a senha inicial também.
   - No primeiro acesso o sistema obriga a troca da senha.
5. **Configurações de Integração** (só o Master), descritas na seção 6.

## 6. Configurações de Integração (menu Administração)
| Integração | Como ligar | Custo |
|---|---|---|
| **Consulta de CNPJ** | Já vem ligada (BrasilAPI). Ao digitar um CNPJ válido no cadastro de loja, preenche cidade, UF, CEP e endereço. Se o serviço cair, tenta a ReceitaWS. | gratuito |
| **Leitor de contratos e apólices por IA** | Escolha OpenAI ou Anthropic, cole a chave de API, clique em **Testar conexão** e depois em **Salvar**. | pago por uso no provedor |
| **Armazenamento de PDFs** | Já vem ligado com o bucket `anexos` criado pelo script. Clique em **Testar envio** para conferir. | dentro do plano do Supabase |

Sobre a chave de IA:
- A chamada sai do navegador de quem usa o leitor.
- Por isso a chave fica legível para quem pode **modificar** Lojas, Contratos ou Retaguarda.
- Crie uma chave **exclusiva do painel** e defina um **limite de gasto mensal** no site do provedor.
- Para esconder a chave de vez, o próximo passo é uma *Edge Function* do Supabase intermediando a chamada.

## 7. Segurança: o que mudou na v15
- **Senhas:** quem guarda é o **Supabase Auth**, com bcrypt no servidor. A tabela do painel não tem nenhuma senha.
- **Regras no servidor (RLS):** cada leitura e gravação é conferida no banco pela matriz do usuário.
  - Salários, usuários, auditoria e chaves de API ficam restritos ao Master.
  - Desativado, desligado no Módulo 1 ou com senha ainda igual ao CPF: o banco não entrega nada na hora. A tela é encerrada em até 30 segundos.
- **Resetar senha:** volta a senha ao CPF e derruba as sessões abertas.
- **Remover acesso:** apaga também o login.
- **PDFs:** o bucket `anexos` é público. Cada arquivo tem um endereço com código aleatório e não aparece em listagens, mas quem tiver o link abre o arquivo.

## 8. Rotina
- **Backup:** semanal, pelo menu Backup.
- **Plano gratuito do Supabase:** o projeto pode ser **pausado** após alguns dias sem uso. Com uso diário isso não acontece. Para uso oficial contínuo, avalie o plano Pro.
