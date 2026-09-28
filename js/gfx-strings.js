// Localized strings for the Graphics settings section. The rest of the UI is English-only;
// this panel follows navigator.languages (exact tag, then language fallback, then en-US).

const en = {
  graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
  low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postUnavailable: 'Post-processing is unavailable on this device; the hall renders without it.',
  gpuUnknown: 'unknown GPU', effects: 'Effects',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Lantern glow (bloom)', grade: 'Colour grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', lanterns: 'Lanterns',
    background: 'Background motion', detail: 'Surface detail',
  },
  tier: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', static: 'Still', animated: 'Animated', plain: 'Plain', detailed: 'Detailed', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  sum: { noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections', lanterns: 'lanterns', noAa: 'no anti-aliasing' },
};

const enUS = { ...en, cat: { ...en.cat, grade: 'Color grade' } };

const es = {
  graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
  low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
  renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
  adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
  postUnavailable: 'El posprocesado no está disponible en este dispositivo; la sala se muestra sin él.',
  gpuUnknown: 'GPU desconocida', effects: 'Efectos',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Brillo de farolillos', grade: 'Corrección de color',
    antialias: 'Suavizado de bordes', reflections: 'Reflejos', lanterns: 'Farolillos',
    background: 'Movimiento del fondo', detail: 'Detalle de superficies',
  },
  tier: { off: 'No', on: 'Sí', low: 'Baja', medium: 'Media', high: 'Alta', static: 'Quieto', animated: 'Animado', plain: 'Sencillo', detailed: 'Detallado', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  sum: { noShadows: 'sin sombras', shadows: 'sombras', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa', bloom: 'brillo', reflections: 'reflejos', lanterns: 'farolillos', noAa: 'sin suavizado' },
};
const es419 = { ...es, auto: 'Automática (detectada: {tier})', cat: { ...es.cat, bloom: 'Brillo de linternas', lanterns: 'Linternas' }, sum: { ...es.sum, lanterns: 'linternas' } };

const de = {
  graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
  low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
  renderScale: 'Renderskalierung', fromPreset: 'Laut Voreinstellung ({tier})',
  adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
  postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; die Halle wird ohne sie dargestellt.',
  gpuUnknown: 'unbekannte GPU', effects: 'Effekte',
  cat: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Laternenschein (Bloom)', grade: 'Farbkorrektur',
    antialias: 'Kantenglättung', reflections: 'Spiegelungen', lanterns: 'Laternen',
    background: 'Hintergrundbewegung', detail: 'Oberflächendetails',
  },
  tier: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', static: 'Still', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  sum: { noShadows: 'keine Schatten', shadows: 'Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung', bloom: 'Bloom', reflections: 'Spiegelungen', lanterns: 'Laternen', noAa: 'keine Kantenglättung' },
};

const fr = {
  graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
  low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
  renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
  adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
  postUnavailable: 'Le post-traitement est indisponible sur cet appareil ; la salle s’affiche sans lui.',
  gpuUnknown: 'GPU inconnu', effects: 'Effets',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo des lanternes', grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage', reflections: 'Reflets', lanterns: 'Lanternes',
    background: 'Animation du décor', detail: 'Détail des surfaces',
  },
  tier: { off: 'Non', on: 'Oui', low: 'Bas', medium: 'Moyen', high: 'Haut', static: 'Fixe', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  sum: { noShadows: 'sans ombres', shadows: 'ombres', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète', bloom: 'halo', reflections: 'reflets', lanterns: 'lanternes', noAa: 'sans anticrénelage' },
};
const frCA = { ...fr, showFps: 'Afficher la fréquence d’images', cat: { ...fr.cat, antialias: 'Lissage des bords' }, sum: { ...fr.sum, noAa: 'sans lissage' } };

const ptBR = {
  graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
  low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
  renderScale: 'Escala de renderização', fromPreset: 'Conforme a predefinição ({tier})',
  adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
  postUnavailable: 'O pós-processamento não está disponível neste aparelho; o salão é exibido sem ele.',
  gpuUnknown: 'GPU desconhecida', effects: 'Efeitos',
  cat: {
    shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho das lanternas', grade: 'Correção de cor',
    antialias: 'Suavização de bordas', reflections: 'Reflexos', lanterns: 'Lanternas',
    background: 'Movimento do fundo', detail: 'Detalhe das superfícies',
  },
  tier: { off: 'Não', on: 'Sim', low: 'Baixo', medium: 'Médio', high: 'Alto', static: 'Parado', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  sum: { noShadows: 'sem sombras', shadows: 'sombras', ao: 'oclusão ambiente', aoHigh: 'oclusão ambiente completa', bloom: 'brilho', reflections: 'reflexos', lanterns: 'lanternas', noAa: 'sem suavização' },
};

const it = {
  graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
  low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
  renderScale: 'Scala di rendering', fromPreset: 'Da preimpostazione ({tier})',
  adaptive: 'Risoluzione adattiva', showFps: 'Mostra fotogrammi al secondo',
  postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; la sala viene mostrata senza.',
  gpuUnknown: 'GPU sconosciuta', effects: 'Effetti',
  cat: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore delle lanterne', grade: 'Correzione colore',
    antialias: 'Antialiasing', reflections: 'Riflessi', lanterns: 'Lanterne',
    background: 'Movimento dello sfondo', detail: 'Dettaglio delle superfici',
  },
  tier: { off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', static: 'Fermo', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  sum: { noShadows: 'senza ombre', shadows: 'ombre', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa', bloom: 'bagliore', reflections: 'riflessi', lanterns: 'lanterne', noAa: 'senza antialiasing' },
};

export const GFX_STRINGS = {
  'en-US': enUS, 'en-GB': en, 'es-419': es419, 'es-ES': es, 'de-DE': de,
  'fr-FR': fr, 'fr-CA': frCA, 'pt-BR': ptBR, 'it-IT': it,
};

const LANG_DEFAULT = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Pick a catalogue for the given language tags (e.g. navigator.languages). */
export function pickLocale(langs) {
  for (const raw of langs || []) {
    const tag = String(raw || '');
    const exact = Object.keys(GFX_STRINGS).find((k) => k.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const lang = tag.split('-')[0].toLowerCase();
    if (lang === 'en' && /-(gb|uk|ie|au|nz)$/i.test(tag)) return 'en-GB';
    if (lang === 'es' && /-es$/i.test(tag)) return 'es-ES';
    if (lang === 'fr' && /-ca$/i.test(tag)) return 'fr-CA';
    if (LANG_DEFAULT[lang]) return LANG_DEFAULT[lang];
  }
  return 'en-US';
}
