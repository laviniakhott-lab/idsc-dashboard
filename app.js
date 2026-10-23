/**
 * Observatório do Trabalho — Contagem | app.js
 * Aplicação JavaScript sem dependências, organizada em módulos internos.
 * Espera arquivos JSON em ./data/ e os estilos definidos em styles.css.
 * Para usar este arquivo diretamente, o HTML deve carregá-lo como módulo:
 * <script type="module" src="./app.js"></script>
 *
 * Contratos de dados (JSON):
 * indicators.json: [{"id":"empregos_formais","name":"Empregos formais","unit":"vínculos","source_id":"rais"}]
 * municipalities.json: [{"id":"3118601","name":"Contagem","uf":"MG"}]
 * observations.json: [{"municipality_id":"3118601","indicator_id":"empregos_formais","year":2024,"value":125000,"source_id":"rais"}]
 * sources.json: [{"id":"rais","name":"RAIS/MTE","url":"https://www.gov.br/trabalho-e-emprego/"}]
 * Valores ilustrativos acima não são dados reais. Arquivos faltantes ou inválidos não geram números fictícios.
 */

const Config = Object.freeze({
  dataDir: './data',
  defaultMunicipality: '3118601',
  locale: 'pt-BR',
});

const DOM = (() => {
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'html') throw new Error('Atribuição HTML insegura bloqueada.');
      else node.setAttribute(key, String(value));
    }
    for (const child of children) node.append(child);
    return node;
  };
  const replace = (parent, ...children) => parent.replaceChildren(...children);
  return { el, replace };
})();

const DataService = (() => {
  async function readJSON(name) {
    if (window.location.protocol === 'file:') {
      throw new Error('Este painel precisa ser aberto pelo servidor local (http://localhost), não pelo arquivo file://. Execute iniciar_dashboard.bat.');
    }
    const response = await fetch(`${Config.dataDir}/${name}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Falha ao carregar ${name}.json (HTTP ${response.status}).`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error(`${name}.json precisa conter uma lista.`);
    return value;
  }

  const idOf = row => String(row.id ?? row.code ?? row.codigo_ibge ?? '');
  const yearOf = row => Number(row.year ?? String(row.period ?? '').slice(0, 4));

  async function load() {
    const [indicators, municipalities, observations, sources] = await Promise.all([
      readJSON('indicators'), readJSON('municipalities'), readJSON('observations'), readJSON('sources'),
    ]);
    const normalizedMunicipalities = municipalities.map(m => ({ ...m, id: idOf(m) }));
    const validIndicators = indicators.filter(x => x && x.id != null && x.name);
    const validObservations = observations.filter(o =>
      o && o.municipality_id != null && o.indicator_id != null &&
      Number.isInteger(yearOf(o)) && Number.isFinite(Number(o.value)) && o.value !== null && o.value !== ''
    ).map(o => ({ ...o, municipality_id: String(o.municipality_id), indicator_id: String(o.indicator_id), year: yearOf(o), value: Number(o.value) }));
    return {
      indicators: validIndicators,
      municipalities: normalizedMunicipalities,
      observations: validObservations,
      sources,
    };
  }

  function series(data, state) {
    return data.observations
      .filter(o => o.indicator_id === state.indicator && o.municipality_id === state.municipality)
      .filter(o => o.year >= state.startYear && o.year <= state.endYear)
      .sort((a, b) => a.year - b.year || String(a.period ?? '').localeCompare(String(b.period ?? '')));
  }

  function availableMunicipalities(data, indicator) {
    return new Set(data.observations.filter(o => o.indicator_id === indicator).map(o => o.municipality_id));
  }

  function availableYears(data, indicator, municipality) {
    return [...new Set(data.observations
      .filter(o => o.indicator_id === indicator && o.municipality_id === municipality)
      .map(o => o.year))].sort((a, b) => a - b);
  }

  return { load, series, availableYears, availableMunicipalities };
})();

const Format = (() => {
  const decimal = new Intl.NumberFormat(Config.locale, { maximumFractionDigits: 2 });
  const percentage = new Intl.NumberFormat(Config.locale, { style: 'percent', maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  const displayValue = (number, unit) => Number.isFinite(number) ? `${decimal.format(number)}${unit === '%' ? '%' : ''}` : 'Indisponível';
  const change = (initial, final) => Number.isFinite(initial) && Number.isFinite(final) && initial !== 0
    ? (final - initial) / Math.abs(initial) : null;
  return { decimal, percentage, displayValue, change };
})();

const State = (() => {
  const value = { indicator: '', municipality: '', year: null, startYear: null, endYear: null, search: '' };
  const listeners = new Set();
  const get = () => ({ ...value });
  const set = patch => { Object.assign(value, patch); for (const subscriber of listeners) subscriber(get()); };
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  return { get, set, subscribe };
})();

const Calculations = (() => {
  // Para séries anuais, escolhe apenas anos com exatamente uma observação.
  // Valores mensais nunca são agregados automaticamente a anos.
  function annualPoints(series) {
    const map = new Map();
    for (const row of series) {
      const bucket = map.get(row.year) ?? [];
      bucket.push(row);
      map.set(row.year, bucket);
    }
    return [...map.entries()].filter(([, rows]) => rows.length === 1)
      .map(([year, rows]) => ({ year, value: rows[0].value, row: rows[0] }))
      .sort((a, b) => a.year - b.year);
  }
  function compare(points, firstYear, lastYear) {
    const a = points.find(p => p.year === firstYear);
    const b = points.find(p => p.year === lastYear);
    if (!a || !b || firstYear === lastYear) return null;
    return { a, b, absolute: b.value - a.value, percentage: Format.change(a.value, b.value) };
  }
  return { annualPoints, compare };
})();

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, props = {}, text) => {
    const node = document.createElementNS(NS, tag);
    Object.entries(props).forEach(([k, v]) => node.setAttribute(k, String(v)));
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  function renderLine(target, points, unit, selectedYear) {
    if (!points.length) { DOM.replace(target, DOM.el('p', { text: 'Sem dados anuais comparáveis para o intervalo selecionado.' })); return; }
    const W = 900, H = 310, margin = { left: 85, right: 25, top: 25, bottom: 48 };
    const values = points.map(p => p.value);
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { const padding = Math.max(Math.abs(min) * .1, 1); min -= padding; max += padding; }
    const x = i => margin.left + (points.length === 1 ? (W - margin.left - margin.right) / 2 : i * (W - margin.left - margin.right) / (points.length - 1));
    const y = val => margin.top + (max - val) * (H - margin.top - margin.bottom) / (max - min);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Evolução temporal do indicador (${unit || 'valor'})` });
    for (let i = 0; i <= 4; i++) {
      const v = min + (max - min) * i / 4, py = y(v);
      svg.append(svgEl('line', { x1: margin.left, y1: py, x2: W - margin.right, y2: py, stroke: '#dbe6df' }));
      svg.append(svgEl('text', { x: margin.left - 9, y: py + 4, 'text-anchor': 'end', fill: '#63776d', 'font-size': 12 }, Format.decimal.format(v)));
    }
    const positions = points.map((point, i) => `${x(i)},${y(point.value)}`).join(' ');
    svg.append(svgEl('polyline', { points: positions, fill: 'none', stroke: '#237552', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    points.forEach((p, i) => {
      const circle = svgEl('circle', { cx: x(i), cy: y(p.value), r: p.year === selectedYear ? 6 : 4, fill: p.year === selectedYear ? '#123d30' : '#237552' });
      circle.append(svgEl('title', {}, `${p.year}: ${Format.displayValue(p.value, unit)}`));
      svg.append(circle);
      svg.append(svgEl('text', { x: x(i), y: H - 15, 'text-anchor': 'middle', fill: '#63776d', 'font-size': 11 }, p.year));
    });
    DOM.replace(target, svg);
  }
  function renderBars(target, comparison, unit) {
    if (!comparison) { DOM.replace(target, DOM.el('p', { text: 'Selecione dois anos com dados anuais disponíveis para comparar.' })); return; }
    const values = [comparison.a, comparison.b];
    const svg = svgEl('svg', { viewBox: '0 0 800 300', width: '100%', role: 'img', 'aria-label': 'Comparação entre os anos selecionados' });
    const min = Math.min(0, ...values.map(v => v.value));
    const max = Math.max(0, ...values.map(v => v.value));
    const span = max - min || 1;
    const scale = v => 245 - (v - min) / span * 200;
    const baseline = scale(0);
    svg.append(svgEl('line', { x1: 70, x2: 750, y1: baseline, y2: baseline, stroke: '#63776d' }));
    values.forEach((p, i) => {
      const cx = 250 + i * 300, top = Math.min(scale(p.value), baseline), height = Math.max(1, Math.abs(scale(p.value) - baseline));
      const rect = svgEl('rect', { x: cx - 65, y: top, width: 130, height, rx: 4, fill: i === 0 ? '#78ad8c' : '#237552' });
      rect.append(svgEl('title', {}, `${p.year}: ${Format.displayValue(p.value, unit)}`));
      svg.append(rect);
      svg.append(svgEl('text', { x: cx, y: 275, 'text-anchor': 'middle', fill: '#17312a' }, p.year));
      svg.append(svgEl('text', { x: cx, y: Math.max(15, top - 9), 'text-anchor': 'middle', fill: '#17312a', 'font-size': 13 }, Format.decimal.format(p.value)));
    });
    DOM.replace(target, svg);
  }
  return { renderLine, renderBars };
})();

const ExportService = (() => {
  function exportCSV(rows, indicator, municipality) {
    const headers = ['Município', 'Código IBGE', 'Indicador', 'Ano', 'Período', 'Valor', 'Unidade', 'Fonte'];
    const quote = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
    // Protege o CSV de fórmulas ao abrir em planilhas.
    const text = v => { const s = String(v ?? ''); return /^[\s]*[=+@\-\t\r]/.test(s) ? `'${s}` : s; };
    const body = rows.map(o => [municipality.name, municipality.id, indicator.name, o.year, o.period ?? o.year, String(o.value).replace('.', ','), indicator.unit ?? '', o.source_id ?? indicator.source_id ?? ''].map((v, i) => quote(i === 5 ? v : text(v))).join(';'));
    const csv = '\uFEFF' + [headers.map(quote).join(';'), ...body].join('\r\n');
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.href = url;
    link.download = `observatorio_${indicator.id}_${municipality.id}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { exportCSV };
})();

const App = (() => {
  let data;
  const refs = {};

  const field = (label, id) => {
    const select = DOM.el('select', { id, name: id });
    const wrapper = DOM.el('div', { className: 'filter-field' }, [DOM.el('label', { for: id, text: label }), select]);
    refs[id] = select;
    return wrapper;
  };
  const panel = (title, content) => DOM.el('section', { className: 'panel' }, [
    DOM.el('div', { className: 'section-heading' }, [DOM.el('h2', { text: title })]), content,
  ]);

  function build() {
    const root = document.getElementById('root');
    if (!root) throw new Error('Elemento #root não encontrado.');
    refs.status = DOM.el('p', { className: 'source-note', role: 'status', 'aria-live': 'polite' });
    const selectors = DOM.el('div', { className: 'filters-grid' }, [
      field('Indicador', 'indicator'), field('Município', 'municipality'), field('Ano de referência', 'year'),
      field('Ano inicial', 'startYear'), field('Ano final', 'endYear'),
    ]);
    const reset = DOM.el('button', { className: 'btn btn-secondary', type: 'button', text: 'Limpar filtros' });
    reset.addEventListener('click', defaults);
    selectors.append(DOM.el('div', { className: 'filter-actions' }, [reset]));
    refs.kpis = DOM.el('div', { className: 'kpi-grid' });
    refs.line = DOM.el('div', { className: 'chart-container' });
    refs.bars = DOM.el('div', { className: 'chart-container' });
    refs.comparisonDetails = DOM.el('div', { className: 'comparison-details', 'aria-live': 'polite' });
    refs.comparisonNote = DOM.el('p', { className: 'chart-note' });
    refs.search = DOM.el('input', { className: 'table-search', type: 'search', placeholder: 'Pesquisar na tabela', 'aria-label': 'Pesquisar na tabela' });
    refs.export = DOM.el('button', { className: 'btn btn-primary', type: 'button', text: 'Exportar CSV' });
    refs.table = DOM.el('div', { className: 'table-wrapper' });
    refs.source = DOM.el('p', { className: 'source-note' });
    const tablePanel = DOM.el('section', { className: 'panel' }, [
      DOM.el('div', { className: 'section-heading' }, [DOM.el('h2', { text: 'Tabela de dados' })]),
      DOM.el('div', { className: 'table-toolbar' }, [refs.search, refs.export]), refs.table,
    ]);
    const main = DOM.el('main', { className: 'main-container' }, [
      DOM.el('h2', { className: 'page-title', text: 'Indicadores municipais' }),
      DOM.el('p', { className: 'page-description', text: 'Consulte séries históricas, compare anos e exporte dados.' }),
      panel('Filtros', selectors), refs.status, refs.kpis,
      panel('Evolução temporal', refs.line), panel('Comparação entre dois anos', DOM.el('div', {}, [refs.bars, refs.comparisonDetails, refs.comparisonNote])), tablePanel, refs.source,
    ]);
    DOM.replace(root, DOM.el('div', { className: 'app-shell' }, [
      DOM.el('header', { className: 'site-header' }, [DOM.el('div', { className: 'header-inner' }, [
        DOM.el('div', { className: 'brand' }, [DOM.el('div', {}, [
          DOM.el('h1', { text: 'Observatório do Trabalho — Contagem' }),
          DOM.el('p', { text: 'Indicadores e dados municipais' }),
        ])]),
      ])]), main,
      DOM.el('footer', {}, [DOM.el('div', { className: 'footer-inner', text: 'Observatório do Trabalho — dados sujeitos à disponibilidade das fontes.' })]),
    ]));
    for (const key of ['indicator', 'municipality', 'year', 'startYear', 'endYear']) {
      refs[key].addEventListener('change', () => onFilter(key));
    }
    refs.search.addEventListener('input', e => State.set({ search: e.target.value }));
    refs.export.addEventListener('click', () => {
      const s = State.get(), indicator = getIndicator(s), municipality = getMunicipality(s);
      const rows = visibleRows(s);
      if (rows.length && indicator && municipality) ExportService.exportCSV(rows, indicator, municipality);
    });
  }

  function options(select, entries, value) {
    DOM.replace(select, ...entries.map(([id, label]) => DOM.el('option', { value: id, text: label })));
    select.value = String(value ?? '');
    select.disabled = entries.length === 0;
    select.setAttribute('aria-disabled', String(select.disabled));
  }
  const getIndicator = s => data.indicators.find(i => String(i.id) === s.indicator);
  const getMunicipality = s => data.municipalities.find(m => m.id === s.municipality);
  function years(s) { return DataService.availableYears(data, s.indicator, s.municipality); }
  function comparableYears(s) {
    const allRows = data.observations.filter(o => o.indicator_id === s.indicator && o.municipality_id === s.municipality);
    return Calculations.annualPoints(allRows).map(p => p.year);
  }
  function defaults() {
    const populated = new Set(data.observations.map(o => o.indicator_id));
    const indicator = String(data.indicators.find(i => populated.has(String(i.id)))?.id ?? data.indicators[0]?.id ?? '');
    const permitted = DataService.availableMunicipalities(data, indicator);
    const municipality = (permitted.has(Config.defaultMunicipality) ? Config.defaultMunicipality : data.municipalities.find(m => permitted.has(m.id))?.id)
      ?? data.municipalities.find(m => m.id === Config.defaultMunicipality)?.id ?? data.municipalities[0]?.id ?? '';
    const available = DataService.availableYears(data, indicator, municipality);
    const comparable = comparableYears({ indicator, municipality });
    State.set({ indicator, municipality, year: available.at(-1) ?? null, startYear: comparable[0] ?? null, endYear: comparable.at(-1) ?? null, search: '' });
    refs.search.value = '';
  }
  function onFilter(key) {
    const old = State.get(), val = ['indicator', 'municipality'].includes(key) ? refs[key].value : Number(refs[key].value);
    const next = { ...old, [key]: val };
    if (key === 'indicator') {
      const permitted = DataService.availableMunicipalities(data, next.indicator);
      if (!permitted.has(next.municipality) && permitted.size) {
        next.municipality = permitted.has(Config.defaultMunicipality) ? Config.defaultMunicipality
          : data.municipalities.find(m => permitted.has(m.id))?.id ?? next.municipality;
      }
    }
    if (key === 'indicator' || key === 'municipality') {
      const available = DataService.availableYears(data, next.indicator, next.municipality);
      const comparable = comparableYears(next);
      next.year = available.includes(old.year) ? old.year : available.at(-1) ?? null;
      next.startYear = comparable.includes(old.startYear) ? old.startYear : comparable[0] ?? null;
      next.endYear = comparable.includes(old.endYear) ? old.endYear : comparable.at(-1) ?? null;
    }
    if (next.startYear != null && next.endYear != null && next.startYear > next.endYear) {
      if (key === 'startYear') next.endYear = next.startYear;
      else next.startYear = next.endYear;
    }
    State.set(next);
  }
  function visibleRows(s) {
    const query = s.search.trim().toLocaleLowerCase(Config.locale);
    const rows = DataService.series(data, s);
    if (!query) return rows;
    const ind = getIndicator(s), municipality = getMunicipality(s);
    return rows.filter(row => [municipality?.name, ind?.name, row.year, row.period, row.value, row.source_id]
      .some(item => String(item ?? '').toLocaleLowerCase(Config.locale).includes(query)));
  }
  function renderTable(rows, indicator, municipality) {
    const columns = ['Município', 'Indicador', 'Ano', 'Período', 'Valor', 'Fonte'];
    const table = DOM.el('table', { className: 'data-table' });
    table.append(DOM.el('thead', {}, [DOM.el('tr', {}, columns.map(c => DOM.el('th', { scope: 'col', text: c })))]));
    const tbody = DOM.el('tbody');
    for (const row of rows) tbody.append(DOM.el('tr', {}, [
      municipality.name, indicator.name, row.year, row.period ?? row.year,
      Format.displayValue(row.value, indicator.unit), row.source_id ?? indicator.source_id ?? '—',
    ].map(v => DOM.el('td', { text: v }))));
    table.append(tbody);
    DOM.replace(refs.table, rows.length ? table : DOM.el('p', { text: 'Nenhuma observação para os filtros selecionados.' }));
    refs.export.disabled = rows.length === 0;
  }
  function card(label, value, caption = '') {
    return DOM.el('div', { className: 'card' }, [
      DOM.el('div', { className: 'kpi-label', text: label }),
      DOM.el('div', { className: 'kpi-value', text: value }),
      DOM.el('div', { className: 'kpi-caption', text: caption }),
    ]);
  }
  function renderComparison(comparison, indicator) {
    if (!comparison) {
      DOM.replace(refs.comparisonDetails);
      refs.comparisonNote.textContent = 'Selecione dois anos diferentes com uma única observação anual por ano. Dados mensais e anos duplicados não são agregados automaticamente.';
      return;
    }
    const { a, b, absolute, percentage } = comparison;
    const unit = indicator.unit ?? '';
    const isRate = unit === '%' || unit.toLocaleLowerCase(Config.locale).includes('percentual');
    const signedValue = n => `${n > 0 ? '+' : ''}${Format.decimal.format(n)}`;
    const changeUnit = isRate ? 'p.p.' : unit;
    DOM.replace(refs.comparisonDetails,
      card(`Ano inicial (${a.year})`, Format.displayValue(a.value, unit), indicator.name),
      card(`Ano final (${b.year})`, Format.displayValue(b.value, unit), indicator.name),
      card(isRate ? 'Diferença em pontos percentuais' : 'Variação absoluta', `${signedValue(absolute)} ${changeUnit}`.trim(), `${a.year} → ${b.year}`),
      card('Variação relativa', percentage == null ? 'Não calculável' : Format.percentage.format(percentage), percentage == null ? 'Valor inicial igual a zero' : `${a.year} → ${b.year}`),
    );
    refs.comparisonNote.textContent = `Comparação: ${a.year} versus ${b.year}. Fonte: ${a.row.source_id ?? indicator.source_id ?? 'não informada'} / ${b.row.source_id ?? indicator.source_id ?? 'não informada'}. Variação relativa calculada sobre o módulo do valor inicial; confirme a comparabilidade metodológica antes da interpretação.`;
  }
  function render(s) {
    const indicator = getIndicator(s), municipality = getMunicipality(s);
    options(refs.indicator, data.indicators.map(i => [String(i.id), i.name]), s.indicator);
    const permitted = DataService.availableMunicipalities(data, s.indicator);
    const municipalities = data.municipalities.filter(m => !permitted.size || permitted.has(m.id));
    options(refs.municipality, municipalities.map(m => [m.id, `${m.name}${m.uf ? ` (${m.uf})` : ''}`]), s.municipality);
    const available = years(s), opts = available.map(y => [y, y]);
    options(refs.year, opts, s.year);
    const comparisonOptions = comparableYears(s).map(y => [y, y]);
    for (const key of ['startYear', 'endYear']) options(refs[key], comparisonOptions, s[key]);
    if (!indicator || !municipality || !available.length) {
      refs.status.textContent = 'Aplicação carregada corretamente. Não há dados disponíveis: preencha os arquivos JSON da pasta data com registros oficiais para habilitar os gráficos e filtros.';
      DOM.replace(refs.kpis, card('Valor', 'Indisponível'));
      DOM.replace(refs.line, DOM.el('p', { text: 'Sem dados para mostrar.' }));
      DOM.replace(refs.bars, DOM.el('p', { text: 'Sem dados para mostrar.' }));
      DOM.replace(refs.comparisonDetails);
      refs.comparisonNote.textContent = '';
      DOM.replace(refs.table, DOM.el('p', { text: 'Sem dados para mostrar.' }));
      refs.export.disabled = true;
      refs.source.textContent = '';
      return;
    }
    const observations = DataService.series(data, s);
    const points = Calculations.annualPoints(observations);
    const current = points.find(p => p.year === s.year);
    const comparison = Calculations.compare(points, s.startYear, s.endYear);
    const changeLabel = comparison?.percentage == null ? 'Indisponível' : Format.percentage.format(comparison.percentage);
    DOM.replace(refs.kpis,
      card('Valor de referência', current ? Format.displayValue(current.value, indicator.unit) : 'Indisponível', `${s.year ?? '—'} • ${indicator.unit ?? 'unidade não informada'}`),
      card('Variação entre anos', changeLabel, comparison ? `${comparison.a.year} → ${comparison.b.year} • Diferença: ${Format.decimal.format(comparison.absolute)}` : 'Não comparável'),
      card('Ano de referência', String(s.year ?? '—'), municipality.name),
    );
    Charts.renderLine(refs.line, points, indicator.unit, s.year);
    Charts.renderBars(refs.bars, comparison, indicator.unit);
    renderComparison(comparison, indicator);
    renderTable(visibleRows(s), indicator, municipality);
    const source = data.sources.find(x => String(x.id) === String(indicator.source_id));
    refs.source.textContent = `Fonte: ${source?.name ?? indicator.source_id ?? 'não informada'} • ${indicator.description ?? 'Consulte a metodologia da fonte antes de comparar indicadores.'}`;
    refs.status.textContent = `${observations.length} observação(ões) no intervalo selecionado. Séries com múltiplos registros por ano não são agregadas automaticamente.`;
  }
  async function init() {
    build();
    refs.status.textContent = 'Carregando dados…';
    try {
      data = await DataService.load();
      State.subscribe(render);
      defaults();
    } catch (error) {
      console.error('Erro de inicialização do dashboard:', error);
      refs.status.textContent = `Erro ao carregar dados: ${error.message} Verifique a pasta data/ e abra o painel pelo servidor local.`;
      refs.export.disabled = true;
      for (const key of ['indicator', 'municipality', 'year', 'startYear', 'endYear']) refs[key].disabled = true;
    }
  }
  return { init };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', App.init, { once: true });
else App.init();
