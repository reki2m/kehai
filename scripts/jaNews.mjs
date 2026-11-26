/** Shared with src/lib/jaNews.ts — edit both when changing translations. */

const EXACT = {
  // US
  'Non-Farm Employment Change': '非農業部門雇用者数',
  'Nonfarm Payrolls': '非農業部門雇用者数',
  'NFP': '非農業部門雇用者数',
  'Unemployment Rate': '失業率',
  'Unemployment Claims': '新規失業保険申請件数',
  'Average Hourly Earnings m/m': '平均時給 前月比',
  'Average Hourly Earnings y/y': '平均時給 前年比',
  'ADP Non-Farm Employment Change': 'ADP雇用統計',
  'ADP Employment Change': 'ADP雇用統計',
  'ADP Weekly Employment Change': 'ADP週次雇用変化',
  'JOLTS Job Openings': 'JOLTS求人件数',
  'CPI m/m': '消費者物価指数(CPI) 前月比',
  'CPI y/y': '消費者物価指数(CPI) 前年比',
  'Core CPI m/m': 'コアCPI 前月比',
  'Core CPI y/y': 'コアCPI 前年比',
  'Core PCE Price Index m/m': 'コアPCE物価指数 前月比',
  'Core PCE Price Index y/y': 'コアPCE物価指数 前年比',
  'PPI m/m': '生産者物価指数(PPI) 前月比',
  'PPI y/y': '生産者物価指数(PPI) 前年比',
  'Core PPI m/m': 'コアPPI 前月比',
  'GDP m/m': 'GDP 前月比',
  'GDP q/q': 'GDP 前期比',
  'Prelim GDP q/q': 'GDP速報 前期比',
  'Final GDP q/q': 'GDP確報 前期比',
  'Prelim GDP Price Index q/q': 'GDP物価指数速報 前期比',
  'Flash GDP q/q': 'GDPフラッシュ 前期比',
  'Interest Rate Decision': '政策金利決定',
  'Federal Funds Rate': 'FF金利',
  'FOMC Statement': 'FOMC声明',
  'FOMC Meeting Minutes': 'FOMC議事要旨',
  'FOMC Press Conference': 'FOMC記者会見',
  'Fed Chair Powell Speaks': 'パウエルFRB議長 発言',
  'Fed Chair Powell Testifies': 'パウエルFRB議長 議会証言',
  'Beige Book': 'ベージュブック',
  'Retail Sales m/m': '小売売上高 前月比',
  'Core Retail Sales m/m': 'コア小売売上高 前月比',
  'Durable Goods Orders m/m': '耐久財受注 前月比',
  'Core Durable Goods Orders m/m': 'コア耐久財受注 前月比',
  'Industrial Production m/m': '鉱工業生産 前月比',
  'Capacity Utilization': '設備稼働率',
  'Consumer Confidence': '消費者信頼感指数',
  'CB Consumer Confidence': 'カンファレンスボード消費者信頼感',
  'ISM Manufacturing PMI': 'ISM製造業PMI',
  'ISM Services PMI': 'ISM非製造業PMI',
  'Flash Manufacturing PMI': '製造業PMI速報',
  'Flash Services PMI': 'サービス業PMI速報',
  'Final Manufacturing PMI': '製造業PMI確報',
  'Final Services PMI': 'サービス業PMI確報',
  'Building Permits': '住宅着工許可件数',
  'Housing Starts': '住宅着工件数',
  'New Home Sales': '新築住宅販売件数',
  'Existing Home Sales': '中古住宅販売件数',
  'Pending Home Sales m/m': '住宅仮契約 前月比',
  'HPI m/m': '住宅価格指数 前月比',
  'S&P/CS Composite-20 HPI y/y': 'S&P/CS住宅価格指数 前年比',
  'Trade Balance': '貿易収支',
  'Goods Trade Balance': '財貿易収支',
  'Crude Oil Inventories': '原油在庫',
  'Natural Gas Storage': '天然ガス在庫',
  'API Weekly Statistical Bulletin': 'API週次統計',
  'Personal Income m/m': '個人所得 前月比',
  'Personal Spending m/m': '個人消費支出 前月比',
  'Prelim Wholesale Inventories m/m': '卸売在庫速報 前月比',
  'Richmond Manufacturing Index': 'リッチモンド連銀製造業指数',
  'Empire State Manufacturing Index': 'ニューヨーク連銀製造業指数',
  'Philly Fed Manufacturing Index': 'フィラデルフィア連銀製造業指数',
  'Michigan Consumer Sentiment': 'ミシガン大消費者信頼感',
  'Prelim UoM Consumer Sentiment': 'ミシガン大消費者信頼感速報',
  'Final UoM Consumer Sentiment': 'ミシガン大消費者信頼感確報',

  // Japan
  'BOJ Policy Rate': '日銀政策金利',
  'BOJ Interest Rate Decision': '日銀政策金利決定',
  'Monetary Policy Statement': '金融政策声明',
  'BOJ Press Conference': '日銀総裁記者会見',
  'BOJ Outlook Report': '日銀展望レポート',
  'BOJ Core CPI y/y': '日銀コアCPI 前年比',
  'Tokyo Core CPI y/y': '東京都区部コアCPI 前年比',
  'National Core CPI y/y': '全国コアCPI 前年比',
  'Tankan Large Manufacturers Index': '日銀短観・大企業製造業',
  'Tankan Large Non-Manufacturers Index': '日銀短観・大企業非製造業',
  'Monetary Base y/y': 'マネタリーベース 前年比',

  // Eurozone / UK / DE / FR / etc.
  'ECB Interest Rate Decision': 'ECB政策金利決定',
  'Main Refinancing Rate': 'ECB主要リファイナンス金利',
  'ECB Press Conference': 'ECB記者会見',
  'ECB Monetary Policy Meeting Accounts': 'ECB金融政策議事要旨',
  'Monetary Policy Rate': '政策金利',
  'Bank Rate': '英政策金利',
  'MPC Official Bank Rate Votes': 'MPC政策金利投票',
  'MPC Meeting Minutes': 'MPC議事要旨',
  'Monetary Policy Report Hearings': '金融政策報告ヒアリング',
  'BOE Financial Stability Report': '英中銀金融安定報告',
  'FPC Meeting Minutes': 'FPC議事要旨',
  'FPC Statement': 'FPC声明',
  'M3 Money Supply y/y': 'マネーサプライM3 前年比',
  'Private Loans y/y': '民間貸出 前年比',
  'SPPI y/y': 'サービス生産者物価 前年比',
  'German Final GDP q/q': 'ドイツGDP確報 前期比',
  'German Flash Manufacturing PMI': 'ドイツ製造業PMI速報',
  'German Flash Services PMI': 'ドイツサービス業PMI速報',
  'German GfK Consumer Climate': 'ドイツGfK消費者信頼感',
  'German Unemployment Change': 'ドイツ失業者数変化',
  'German ifo Business Climate': 'ドイツifo企業景況感',
  'German 10-y Bond Auction': 'ドイツ10年債入札',
  'German Buba President Nagel Speaks': 'ナーゲル独連銀総裁 発言',
  'French Flash Manufacturing PMI': 'フランス製造業PMI速報',
  'French Flash Services PMI': 'フランスサービス業PMI速報',
  'French Prelim CPI m/m': 'フランスCPI速報 前月比',
  'French Prelim GDP q/q': 'フランスGDP速報 前期比',
  'French Consumer Spending m/m': 'フランス消費支出 前月比',
  'French Final Private Payrolls q/q': 'フランス民間雇用確報 前期比',
  'Spanish Flash CPI y/y': 'スペインCPI速報 前年比',
  'Italian 10-y Bond Auction': 'イタリア10年債入札',
  'Belgian NBB Business Climate': 'ベルギーNBB企業景況感',
  'CBI Realized Sales': '英CBI実現売上',
  'Euro Summit': 'ユーロ圏サミット',
}

const NAME_JA = {
  Powell: 'パウエル',
  Ueda: '植田',
  Bailey: 'ベイリー',
  Lagarde: 'ラガルド',
  Nagel: 'ナーゲル',
  Bowman: 'ボウマン',
  Williams: 'ウィリアムズ',
  Greene: 'グリーン',
  Pill: 'ピル',
  Waller: 'ウォラー',
  Barr: 'バー',
  Cook: 'クック',
  Jefferson: 'ジェファーソン',
  Kashkari: 'カシュカリ',
  Harker: 'ハーカー',
  Bostic: 'ボスティック',
  Daly: 'デイリー',
  Goolsbee: 'グールズビー',
  Mester: 'メスター',
  Schnabel: 'シュナーベル',
  Lane: 'レーン',
  Villeroy: 'ヴィルロワ',
  Panetta: 'パネッタ',
  deGuindos: 'デギンドス',
  Kuroda: '黒田',
  Himino: '日野',
  Uchida: '内田',
}

const PREFIX_JA = [
  [/^German\s+/i, 'ドイツ'],
  [/^French\s+/i, 'フランス'],
  [/^Spanish\s+/i, 'スペイン'],
  [/^Italian\s+/i, 'イタリア'],
  [/^British\s+/i, '英国'],
  [/^UK\s+/i, '英国'],
  [/^Japanese\s+/i, '日本'],
  [/^Eurozone\s+/i, 'ユーロ圏'],
  [/^EZ\s+/i, 'ユーロ圏'],
]

const PHRASE_JA = [
  [/\bFlash Manufacturing PMI\b/gi, '製造業PMI速報'],
  [/\bFlash Services PMI\b/gi, 'サービス業PMI速報'],
  [/\bFinal Manufacturing PMI\b/gi, '製造業PMI確報'],
  [/\bFinal Services PMI\b/gi, 'サービス業PMI確報'],
  [/\bManufacturing PMI\b/gi, '製造業PMI'],
  [/\bServices PMI\b/gi, 'サービス業PMI'],
  [/\bInterest Rate Decision\b/gi, '政策金利決定'],
  [/\bPress Conference\b/gi, '記者会見'],
  [/\bMeeting Minutes\b/gi, '議事要旨'],
  [/\bMonetary Policy Statement\b/gi, '金融政策声明'],
  [/\bConsumer Confidence\b/gi, '消費者信頼感'],
  [/\bBusiness Climate\b/gi, '企業景況感'],
  [/\bUnemployment Change\b/gi, '失業者数変化'],
  [/\bUnemployment Rate\b/gi, '失業率'],
  [/\bRetail Sales\b/gi, '小売売上高'],
  [/\bTrade Balance\b/gi, '貿易収支'],
  [/\bCore CPI\b/gi, 'コアCPI'],
  [/\bCPI\b/g, 'CPI'],
  [/\bGDP\b/g, 'GDP'],
  [/\bPrelim\b/gi, '速報'],
  [/\bFinal\b/gi, '確報'],
  [/\bFlash\b/gi, '速報'],
]

function localizePersonName(name) {
  const parts = name.trim().split(/\s+/)
  return parts.map((p) => NAME_JA[p] ?? p).join(' ')
}

function applyUnits(s) {
  return s
    .replace(/\bm\/m\b/gi, '前月比')
    .replace(/\by\/y\b/gi, '前年比')
    .replace(/\bq\/q\b/gi, '前期比')
}

/** Forex Factory 指標・発言タイトルを日本語へ。 */
export function translateEventTitle(title) {
  const raw = title.trim()
  if (!raw) return raw
  if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(raw)) return raw

  const exact = EXACT[raw]
  if (exact) return exact

  // "FOMC Member Bowman Speaks" / "MPC Member Pill Speaks"
  let m = raw.match(/^(FOMC|MPC|ECB|BOJ|BoJ|Fed)\s+Member\s+(.+?)\s+Speaks$/i)
  if (m) {
    const body = m[1].toUpperCase() === 'BOJ' ? '日銀審議委員' : `${m[1].toUpperCase()}委員`
    return `${body} ${localizePersonName(m[2])} 発言`
  }

  m = raw.match(/^Fed Chair\s+(.+?)\s+(Speaks|Testifies)$/i)
  if (m) {
    const act = /testify/i.test(m[2]) ? '議会証言' : '発言'
    return `${localizePersonName(m[1])}FRB議長 ${act}`
  }

  m = raw.match(/^BOJ Governor\s+(.+?)\s+Speaks$/i)
  if (m) return `日銀総裁 ${localizePersonName(m[1])} 発言`

  m = raw.match(/^ECB President\s+(.+?)\s+Speaks$/i)
  if (m) return `ECB総裁 ${localizePersonName(m[1])} 発言`

  m = raw.match(/^(.+?)\s+President\s+(.+?)\s+Speaks$/i)
  if (m) return `${m[1]} ${localizePersonName(m[2])}総裁 発言`

  m = raw.match(/^(.+?)\s+Speaks$/i)
  if (m) return `${localizePersonName(m[1])} 発言`

  m = raw.match(/^(.+?)\s+Testifies$/i)
  if (m) return `${localizePersonName(m[1])} 議会証言`

  let out = raw
  for (const [re, ja] of PREFIX_JA) out = out.replace(re, ja)
  for (const [re, ja] of PHRASE_JA) out = out.replace(re, ja)
  out = applyUnits(out)

  // 人名の単独置換（残り英語名）
  for (const [en, ja] of Object.entries(NAME_JA)) {
    out = out.replace(new RegExp(`\\b${en}\\b`, 'g'), ja)
  }

  return out.replace(/\s{2,}/g, ' ').trim()
}

/** ブラックアウトラベルなど短い英語タグ。 */
export function translateNewsLabel(label) {
  const map = {
    NFP: '米雇用統計',
    'US CPI': '米CPI',
    FOMC: 'FOMC',
    BoJ: '日銀',
    BOJ: '日銀',
  }
  return map[label] ?? translateEventTitle(label)
}
