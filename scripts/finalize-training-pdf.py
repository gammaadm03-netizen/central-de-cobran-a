from pathlib import Path
import os,json,re,shutil,zipfile,hashlib
import fitz

root=Path(__file__).resolve().parent.parent
reports=Path(os.environ.get('TRAINING_REPORT_DIR','/workspace/reports/treinamento-central-financeira'))
content=json.loads((root/'docs/treinamento/conteudo.json').read_text())
name='Treinamento_Central_Financeira_Completo.pdf'
pdf=fitz.open(reports/name)
starts={}
for index,page in enumerate(pdf):
    compact=re.sub(r'\s+','',page.get_text())
    marker=re.search(r'ÁREA(\d{2})[·•]',compact)
    if marker:starts[int(marker[1])-1]=index
if len(starts)!=len(content['modules']):raise RuntimeError(f'Found {len(starts)} chapter markers, expected {len(content["modules"])}')
finish=next((i for i,page in enumerate(pdf) if 'ENCERRAMENTOConferênciadeaprendizagem' in re.sub(r'\s+','',page.get_text())),len(pdf)-1)
ends={n:starts[n+1] if n+1 in starts else finish for n in starts}
bookmarks=[[1,'Capa',1],[1,'Como usar e percursos por perfil',2]]
for n,module in enumerate(content['modules']):bookmarks.append([1,f'{n+1:02d}. {module["title"]}',starts[n]+1])
bookmarks.append([1,'Conferência de aprendizagem',len(pdf)])
pdf.set_toc(bookmarks)
pdf.set_metadata({'title':'Treinamento completo — Central Financeira','author':'Central Financeira — Grupo Ecoplast','subject':'Rotinas por área, caminhos e capturas da interface com dados de demonstração','keywords':'treinamento, financeiro, cobrança, contas a pagar, contas a receber, RH, custos','creator':'Central Financeira 0.18.0'})
tmp=reports/'manual-com-marcadores.pdf';pdf.save(tmp,garbage=4,deflate=True);pdf.close();tmp.replace(reports/name)
pdf=fitz.open(reports/name)
modules={module['id']:index for index,module in enumerate(content['modules'])}
groups=[
('01_Acesso_e_Navegacao',['acesso-navegacao','recuperar-senha']),
('02_Painel_e_Resumo_da_Diretoria',['painel-gerencial','resumo-diretoria']),
('03_Caixa_Bancos_e_Estoque',['caixa-bancos','estoque']),
('04_Contas_a_Pagar',['contas-pagar']),
('05_Contas_a_Receber',['contas-receber-consulta','importacao-contas-receber','validacao-recebimentos']),
('06_Cobranca',['cobranca-atendimento','cobranca-email','contatos-descricoes-cobranca','cobranca-tempo']),
('07_Comissoes',['comissoes-cobradoras','comissoes-vendedores']),
('08_Faturamento_e_Margens',['faturamento','margens','importar-fechamento']),
('09_RH_DP',['rh-dp','importar-rh']),
('10_Custos_e_Recalculo',['importar-custos','recalcular-custos']),
('11_Importar_Bases',['importar-bases-geral']),
('12_Administracao_e_Suporte',['administracao-usuarios','administracao-cobradoras','administracao-auditoria','suporte-operacional'])]
area_dir=reports/'por-area';area_dir.mkdir(exist_ok=True)
summary=[]
for filename,ids in groups:
    area=fitz.open();toc=[]
    for id in ids:
        n=modules[id];toc.append([1,content['modules'][n]['title'],len(area)+1]);area.insert_pdf(pdf,from_page=starts[n],to_page=ends[n]-1)
    for n,page in enumerate(area):
        page.add_redact_annot(fitz.Rect(0,page.rect.height-24,page.rect.width,page.rect.height),fill=(1,1,1))
        page.apply_redactions(images=0,graphics=0,text=0)
        page.insert_text((35,page.rect.height-12),'Central Financeira · Treinamento por área · Dados de demonstração',fontsize=7.5,fontname='helv',color=(.38,.46,.43))
        page.insert_text((page.rect.width-64,page.rect.height-12),f'{n+1} / {len(area)}',fontsize=7.5,fontname='helv',color=(.38,.46,.43))
    area.set_toc(toc);area.set_metadata({'title':filename[3:].replace('_',' ')+' — Central Financeira','author':'Central Financeira — Grupo Ecoplast','subject':'Treinamento ilustrado com dados de demonstração'})
    area.save(area_dir/(filename+'.pdf'),garbage=4,deflate=True);summary.append({'file':filename+'.pdf','pages':len(area),'modules':ids});area.close()
pdf.close()
readme='TREINAMENTO CENTRAL FINANCEIRA — 21/10/2026\n\nAbra o PDF completo para consultar todas as áreas, com sumário clicável e marcadores por capítulo.\nA pasta por-area contém os 12 treinamentos separados para distribuir às equipes.\nO HTML é uma versão navegável autônoma: use a busca para encontrar uma área ou rotina.\n\nAs capturas foram feitas na interface 0.18.0, com dados fictícios. Não representam saldos, cadastros ou folha da empresa.\nAs permissões e as atualizações instaladas determinam os recursos disponíveis para cada conta.\n'
(reports/'LEIA-ME.txt').write_text(readme)
with zipfile.ZipFile(reports/'Treinamentos_por_Area.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
    archive.write(reports/name,name)
    archive.write(reports/'Treinamento_Central_Financeira_Completo.html','Treinamento_Central_Financeira_Completo.html')
    archive.write(reports/'LEIA-ME.txt','LEIA-ME.txt')
    for row in summary:archive.write(area_dir/row['file'],'por-area/'+row['file'])
for file in [name,'Treinamentos_por_Area.zip']:shutil.copy2(reports/file,root/'public/treinamento'/file)
report={'chapters':len(content['modules']),'steps':sum(len(module['steps']) for module in content['modules']),'screenshots':len(content['figures']),'pages':len(fitz.open(reports/name)),'bookmarks':len(bookmarks),'areas':summary,'pdf_sha256':hashlib.sha256((reports/name).read_bytes()).hexdigest()}
(reports/'indice-dos-arquivos.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({key:report[key] for key in ['chapters','steps','screenshots','pages','bookmarks']},ensure_ascii=False))
print('Separated area PDFs:',len(summary),'ZIP bytes:',(reports/'Treinamentos_por_Area.zip').stat().st_size)
