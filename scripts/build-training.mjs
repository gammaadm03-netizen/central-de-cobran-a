import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'docs/treinamento/conteudo.json');
const output = path.join(root, 'public/treinamento');
const reports = process.env.TRAINING_REPORT_DIR || '/workspace/reports/treinamento-central-financeira';
const data = JSON.parse(await readFile(source, 'utf8'));
const esc = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const list = items => `<ul>${(items ?? []).map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
const safeId = id => /^[a-z0-9-]+$/.test(id);
if (!Array.isArray(data.modules) || !data.modules.length || !Array.isArray(data.figures)) throw new Error('Invalid training content');
const figures = new Map(data.figures.map(figure => [figure.id, figure]));
const usedFigures = new Set();
const renderedFigureAnchors = new Set();
await mkdir(path.join(output, 'imagens'), { recursive: true });
await mkdir(reports, { recursive: true });
for (const figure of data.figures) {
  if (!safeId(figure.id) || path.basename(figure.file) !== figure.file || !/\.png$/i.test(figure.file)) throw new Error('Invalid training image path');
  let imageSource = path.join(reports, 'imagens', figure.file);
  let bytes;
  try { bytes = await readFile(imageSource); } catch { imageSource = path.join(output, 'imagens', figure.file); bytes = await readFile(imageSource); }
  if (figure.sha256 && createHash('sha256').update(bytes).digest('hex') !== figure.sha256) throw new Error(`Changed training screenshot: ${figure.id}`);
  if (bytes.length < 1000) throw new Error(`Empty image: ${figure.id}`);
  if (path.resolve(imageSource) !== path.join(output, 'imagens', figure.file)) await copyFile(imageSource, path.join(output, 'imagens', figure.file));
  figure.data_url = `data:image/png;base64,${bytes.toString('base64')}`;
}
const roleCards = (data.tracks ?? []).map(track => `<article class="track"><h3>${esc(track.title)}</h3><p>${esc(track.description)}</p><ol>${track.modules.map(id => { const module = data.modules.find(m => m.id === id); if (!module) throw new Error(`Unknown track module ${id}`); return `<li><a href="#${esc(id)}">${esc(module.title)}</a></li>`; }).join('')}</ol></article>`).join('');
function screenshot(id, offline = false) {
  const figure = figures.get(id);
  if (!figure) throw new Error(`Missing screenshot ${id}`);
  usedFigures.add(id);
  const anchor = renderedFigureAnchors.has(id) ? '' : ` id="fig-${esc(id)}"`;
  renderedFigureAnchors.add(id);
  return `<figure${anchor} class="screen-page"><div class="figure-label">TELA ${esc(figure.number)}</div><h3>${esc(figure.title)}</h3><p class="path">${esc(figure.path)}</p><img src="${offline ? figure.data_url : `imagens/${esc(figure.file)}`}" alt="${esc(figure.alt || `Captura da tela ${figure.title}, com dados de demonstração`)}" width="${figure.width || 1440}" height="${figure.height || 1000}" loading="eager"><figcaption>Figura ${esc(figure.number)} · Interface da Central Financeira ${esc(data.version)}. Dados de demonstração; consulte os valores da sua base durante a operação.</figcaption></figure>`;
}
function moduleHtml(module, index, offline) {
  if (!safeId(module.id) || !module.path || !module.steps?.length) throw new Error(`Invalid module ${module.id}`);
  const photos = [...new Set(module.screenshot_ids ?? module.steps.flatMap(step => step.screenshot_ids ?? []))];
  const renderStep = (step, number) => `<li class="step"><div class="step-number">${number + 1}</div><div><h3>${esc(step.title)}</h3><p class="path">${esc(step.path || module.path)}</p><p>${esc(step.text)}</p>${step.bullets ? list(step.bullets) : ''}${step.screenshot_ids?.length ? `<p class="figure-reference">Veja ${step.screenshot_ids.map(id => `<a href="#fig-${esc(id)}">a figura ${esc(figures.get(id)?.number ?? '?')}</a>`).join(' e ')}.</p>` : ''}</div></li>`;
  const blocks = [], emitted = new Set();
  let currentSteps = [], currentPhotos = [];
  function flush() {
    if (currentSteps.length) blocks.push(`<ol class="steps">${currentSteps.join('')}</ol>`);
    blocks.push(...currentPhotos.map(id => screenshot(id, offline)));
    currentSteps = []; currentPhotos = [];
  }
  module.steps.forEach((step, number) => {
    const fresh = (step.screenshot_ids ?? []).filter(id => photos.includes(id) && !emitted.has(id));
    if (fresh.length && currentSteps.length) flush();
    for (const id of fresh) { emitted.add(id); currentPhotos.push(id); }
    currentSteps.push(renderStep(step, number));
  });
  flush();
  blocks.push(...photos.filter(id => !emitted.has(id)).map(id => screenshot(id, offline)));
  const groups = blocks.join('');

  return `<section id="${esc(module.id)}" class="chapter" data-search="${esc([module.title, module.audience, module.path, module.objective, ...module.steps.map(step => `${step.title} ${step.text}`)].join(' ').toLocaleLowerCase('pt-BR'))}"><header class="chapter-header"><p class="eyebrow">ÁREA ${String(index + 1).padStart(2, '0')} · ${esc(module.duration_minutes)} MIN</p><h2>${esc(module.title)}</h2><p class="path">${esc(module.path)}</p><p class="objective">${esc(module.objective)}</p><p class="audience"><strong>Quem utiliza:</strong> ${esc(module.audience)}</p></header><div class="before"><h3>Antes de começar</h3>${list(module.prerequisites)}</div>${groups}<aside class="check-card"><h3>Como conferir o resultado</h3>${list(module.checks)}</aside>${module.exercise ? `<aside class="exercise"><p class="eyebrow">PRÁTICA ORIENTADA</p><h3>${esc(module.exercise.scenario)}</h3>${list(module.exercise.actions)}<p><strong>Resultado esperado:</strong> ${esc(module.exercise.expected)}</p></aside>` : ''}<aside class="pitfalls"><h3>Cuidados desta rotina</h3>${list(module.pitfalls)}</aside><p class="back-top"><a href="#sumario">Voltar ao sumário ↑</a></p></section>`;
}
function html(offline = false) {
  renderedFigureAnchors.clear();
  const toc = data.modules.map((module, index) => `<li><a href="#${esc(module.id)}"><span>${String(index + 1).padStart(2, '0')}</span>${esc(module.title)}</a></li>`).join('');
  const matrix = data.roles.map(role => `<tr><th>${esc(role.title)}</th><td>${esc(role.can)}</td><td>${esc(role.notes)}</td></tr>`).join('');
  const chapters = data.modules.map((module, index) => moduleHtml(module, index, offline)).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Treinamento completo — Central Financeira</title>${offline ? `<style>${data.css}</style>` : '<link rel="stylesheet" href="guia.css">'}</head><body><header class="toolbar"><a href="#sumario">Central Financeira · Treinamento</a><div><button type="button" id="print-guide">Imprimir / salvar PDF</button>${offline ? '' : '<a class="area-link" href="Treinamentos_por_Area.zip" download>Por área (ZIP)</a><a class="pdf-link" href="Treinamento_Central_Financeira_Completo.pdf" download>Baixar PDF</a>'}</div></header><main><section class="cover"><div class="cover-brand"><img src="${offline ? data.logo_data_url : '../ecoplast-logo.png'}" alt="Grupo Ecoplast"><span>GRUPO ECOPLAST<br><strong>Central Financeira</strong></span></div><div class="cover-copy"><p class="eyebrow">TREINAMENTO OPERACIONAL ILUSTRADO</p><h1>Do acesso à<br>conferência final.</h1><p class="cover-subtitle">Caminhos, telas e rotinas de todas as áreas da Central Financeira.</p><div class="cover-tags"><span>${data.modules.length} capítulos</span><span>${data.figures.length} capturas de tela</span><span>Guia por perfil</span></div></div><footer><p>Material preparado para treinamento da equipe · ${esc(data.date_label)}</p><p>Interface de referência ${esc(data.version)} · Horário oficial de Brasília</p></footer></section><section class="intro" id="como-usar"><p class="eyebrow">COMECE AQUI</p><h2>Como usar este treinamento</h2><p>Escolha sua trilha, abra o capítulo e siga os caminhos destacados em verde. Cada rotina contém o que preencher, qual botão usar e como conferir o resultado. As imagens numeradas mostram a interface correspondente.</p><div class="callout"><strong>Sobre as imagens e os exercícios</strong><p>As capturas foram feitas na interface atual, em ambiente local de demonstração. Clientes, pessoas, valores e arquivos exibidos são exemplos fictícios. Realize as práticas em uma base de treinamento preparada pela Gerência; no ambiente de trabalho, use os relatórios oficiais da origem.</p></div><p>A Central depende das bases importadas e das permissões da conta. Este guia documenta a versão ${esc(data.version)}; um recurso que peça atualização precisa ser ativado pelo responsável técnico. As telas do seu acesso podem mostrar menos abas que as imagens da Gerência.</p><div class="flow"><span>Registrar na origem</span><b>→</b><span>Importar e conferir</span><b>→</b><span>Trabalhar pendências</span><b>→</b><span>Consultar a posição</span></div><h3>Escolha seu percurso</h3><div class="track-grid">${roleCards}</div></section><nav id="sumario" class="toc" aria-label="Sumário do treinamento"><p class="eyebrow">TODAS AS ÁREAS</p><h2>Sumário</h2><label class="search-label" for="training-search">Buscar área, botão ou rotina<input id="training-search" type="search" placeholder="Ex.: conciliação, próximos contatos, custo, folha" autocomplete="off"></label><p id="search-status" aria-live="polite"></p><ol>${toc}</ol></nav><section class="roles"><p class="eyebrow">ACESSOS E RESPONSABILIDADES</p><h2>O que cada perfil encontra</h2><div class="table-scroll"><table><thead><tr><th>Perfil</th><th>Áreas e operações</th><th>Observações</th></tr></thead><tbody>${matrix}</tbody></table></div><p>O perfil e as concessões individuais são definidos pela Gerência e pelo responsável técnico. Selecionar o nome de uma cobradora na importação atribui a carteira; não altera as permissões do login.</p></section>${chapters}<section class="finish"><p class="eyebrow">ENCERRAMENTO</p><h2>Conferência de aprendizagem</h2>${list(data.final_checks)}<p>Registre com a Gerência a data do treinamento, as áreas praticadas e as dúvidas que permaneceram. A liberação de uma conta deve acompanhar a função da pessoa na operação.</p><p class="document-meta">Material baseado nas telas e rotinas da versão ${esc(data.version)}. Elaborado em ${esc(data.date_label)}. As capturas não representam posição financeira, cadastro ou folha real.</p></section></main>${offline ? `<script>${data.js}</script>` : '<script src="guia.js" defer></script>'}</body></html>`;
}
data.css = await readFile(path.join(root, 'docs/treinamento/guia.css'), 'utf8');
data.js = await readFile(path.join(root, 'docs/treinamento/guia.js'), 'utf8');
data.logo_data_url = `data:image/png;base64,${(await readFile(path.join(root, 'public/ecoplast-logo.png'))).toString('base64')}`;
await writeFile(path.join(output, 'index.html'), html(false));
await writeFile(path.join(reports, 'Treinamento_Central_Financeira_Completo.html'), html(true));
await writeFile(path.join(output, 'guia.css'), data.css);
await writeFile(path.join(output, 'guia.js'), data.js);
const markdown = [`# Treinamento completo — Central Financeira ${data.version}`, `\n${data.date_label}. Capturas da interface com dados fictícios de treinamento.\n`, ...data.modules.map((module,index) => `## ${index + 1}. ${module.title}\n\n**Caminho:** ${module.path}\n\n${module.objective}\n\n**Quem utiliza:** ${module.audience}\n\n### Antes de começar\n\n${module.prerequisites.map(item=>`- ${item}`).join('\n')}\n\n### Passo a passo\n\n${module.steps.map((step,n)=>`${n+1}. **${step.title}** — ${step.path || module.path}\n\n   ${step.text}`).join('\n\n')}\n\n### Conferência\n\n${module.checks.map(item=>`- ${item}`).join('\n')}\n\n### Cuidados\n\n${module.pitfalls.map(item=>`- ${item}`).join('\n')}\n`)];
await writeFile(path.join(root,'docs/treinamento/TREINAMENTO.md'),markdown.join('\n'));
const referenced = [...usedFigures];
if (referenced.length !== data.figures.length) throw new Error(`Unreferenced screenshots: ${data.figures.filter(f => !usedFigures.has(f.id)).map(f => f.id).join(', ')}`);
console.log(`Training built: ${data.modules.length} chapters, ${data.figures.length} screenshots. HTML generated; PDF is a separate browser export.`);
