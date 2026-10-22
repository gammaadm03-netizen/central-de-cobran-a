# Treinamento operacional ilustrado

Material de referência da Central Financeira **0.18.1**, elaborado em **22/10/2026**. Reúne rotinas por área, caminhos de menus, campos, botões, conferências, exercícios e capturas da interface.

- [Guia completo em texto](TREINAMENTO.md)
- [Versão navegável publicada](https://central-de-cobran-a.pages.dev/treinamento/)
- [PDF ilustrado](../../public/treinamento/Treinamento_Central_Financeira_Completo.pdf)

A versão navegável permite buscar áreas e rotinas. O PDF oferece sumário clicável e marcadores por capítulo. As capturas vêm do aplicativo local com respostas fictícias de treinamento; não representam cadastros, saldos, folhas ou títulos reais. Nenhuma conta real é usada nas capturas. Elas refletem o layout e os controles existentes; alguns campos nativos de data/arquivo seguem o idioma do navegador.

O pacote ZIP reúne o PDF completo, a versão HTML autônoma e 12 PDFs separados por área. O treinamento descreve os recursos implementados. A disponibilidade na conta depende das permissões e das atualizações instaladas no ambiente. O material não comprova instalação ou execução de operações no Supabase remoto.

## Arquivos de origem

`conteudo.json` contém capítulos, trilhas por perfil, matriz de acesso e metadados das figuras, incluindo o hash de cada imagem. `guia.css` e `guia.js` definem apresentação, impressão e busca. As imagens de demonstração ficam em `public/treinamento/imagens`.

`build-training.mjs` gera a página pública, uma cópia HTML autônoma em relatórios e o guia de texto. As imagens existentes no repositório permitem regenerar o guia sem recapturar o sistema. A exportação PDF requer Python com PyMuPDF (`fitz`) para adicionar os marcadores e separar as áreas. `render-training-pdf.mjs` abre a cópia autônoma em um servidor temporário restrito ao próprio documento, verifica links e imagens e gera o PDF. Não acessa a base remota.

Para atualizar apenas o conteúdo:

```sh
npm run training:build
npm run training:pdf
```

O destino local padrão é `/workspace/reports/treinamento-central-financeira`; pode ser alterado com `TRAINING_REPORT_DIR`. O navegador pode ser indicado com `CHROMIUM_PATH`.

## Atualização das capturas

Gere o aplicativo com `npm run build` e inicie `npm run preview -- --port 4173` em outro terminal. Execute `npm run training:capture`. O script reaproveita os contratos das fixtures locais, substitui nomes por exemplos e intercepta as chamadas de dados; não importa arquivos ou altera a base de produção. O log e o manifesto devem ser revisados antes de incorporar uma nova foto. `CAPTURE_AREAS` e `CAPTURE_ONLY` permitem recapturar partes do material.

Depois de revisar as fotos, atualize as dimensões e hashes no conteúdo, regenere os documentos e confira visualmente a paginação. Capturas de erros ou telas ainda carregando não devem substituir exemplos de rotinas normais.
