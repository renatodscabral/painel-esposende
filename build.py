import os,sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
d=os.path.dirname(os.path.abspath(__file__))
r=lambda f:open(os.path.join(d,f),encoding='utf-8').read()
js='\n'.join([f"const LOGO_BRANCO = '{r('logo.b64')}';", f"const LOGO_NAVY = '{r('logo-navy.b64')}';", r('core.js'), r('folha.js'), r('rh.js'), r('pessoal.js'), r('lojas.js'), r('contratos.js'), r('aluguel.js'), r('financeiro.js'), r('retaguarda.js'), r('retaguarda-fin.js'), r('adquirentes.js'), r('fcx.js'), r('fcx-dfc.js'), r('nuvem.js'), r('acessos.js'), r('app.js')])
page=f'''<title>Painel de Gestão Esposende</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
{r('styles.css')}
</style>
<header id="topbar" class="topbar"></header>
<main class="wrap" id="main"></main>
<div class="wrap fcx-host" id="fcxHost" hidden></div>
<div id="modais"></div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
{js}
</script>
'''
os.makedirs(os.path.join(d,'dist'),exist_ok=True)
open(os.path.join(d,'dist','index.html'),'w',encoding='utf-8').write(page)
open(os.path.join(d,'dist','local.html'),'w',encoding='utf-8').write('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+page+'</body></html>')
import fcx_patch  # FCX original + ajustes de desempenho/integração (ver fcx_patch.py)
open(os.path.join(d,'dist','fcx.html'),'w',encoding='utf-8').write(fcx_patch.patch(r('fcx-original.html')))
# ---------- pacote para hospedagem estática (intranet / Vercel) ----------
import shutil
ex=os.path.join(d,'dist','export'); os.makedirs(os.path.join(ex,'libs'),exist_ok=True)
cfg='<script>window.PAINEL_LIBS = "libs/";</script><script src="config.js"></script>'
open(os.path.join(ex,'index.html'),'w',encoding='utf-8').write('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"></head><body>'+cfg+page+'</body></html>')
fcx=fcx_patch.patch(r('fcx-original.html')).replace('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js','libs/chart.umd.min.js').replace('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js','libs/xlsx.full.min.js')
open(os.path.join(ex,'fcx.html'),'w',encoding='utf-8').write(fcx)
SP=os.path.dirname(d)
for src,dst in [('xl/package/dist/xlsx.full.min.js','xlsx.full.min.js'),('package/dist/chart.umd.js','chart.umd.min.js'),('pdfjs/package/build/pdf.min.js','pdf.min.js'),('pdfjs/package/build/pdf.worker.min.js','pdf.worker.min.js'),('sb/package/dist/umd/supabase.js','supabase.min.js')]:
    shutil.copy(os.path.join(SP,src),os.path.join(ex,'libs',dst))
for f in ['config.js','gerar-config.js','vercel.json']: shutil.copy(os.path.join(d,'instalacao',f),os.path.join(ex,f))
os.makedirs(os.path.join(ex,'supabase'),exist_ok=True); shutil.copy(os.path.join(d,'supabase','instalar.sql'),os.path.join(ex,'supabase','instalar.sql'))
if os.path.exists(os.path.join(d,'LEIA-ME.md')): shutil.copy(os.path.join(d,'LEIA-ME.md'),os.path.join(ex,'LEIA-ME.md'))
print(len(page))
