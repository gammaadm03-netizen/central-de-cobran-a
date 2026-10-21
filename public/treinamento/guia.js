(() => {
  const search = document.getElementById('training-search');
  const status = document.getElementById('search-status');
  const chapters = Array.from(document.querySelectorAll('.chapter'));
  const links = Array.from(document.querySelectorAll('.toc ol li'));
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
  search?.addEventListener('input', () => {
    const query = normalize(search.value);
    let count = 0;
    chapters.forEach((chapter, index) => {
      const matches = !query || normalize(chapter.dataset.search || '').includes(query);
      chapter.hidden = !matches;
      links[index].hidden = !matches;
      if (matches) count++;
    });
    status.textContent = query ? `${count} capítulo(s) encontrado(s). Limpe a busca para ver o treinamento completo.` : '';
  });
  document.getElementById('print-guide')?.addEventListener('click', () => {
    if (search.value) { search.value = ''; search.dispatchEvent(new Event('input')); }
    window.print();
  });
})();
