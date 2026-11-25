# KEHAI

高性能 FX テクニカルインジケータ。気配スコアとコンフルエンスで、チャート上の判断を補助します。

## 機能

- Canvas ベースの高速ローソク足チャート（lightweight-charts）
- EMA / Bollinger / MACD / RSI オーバーレイ切替
- RSI・MACD・ストキャス・BB などからの気配コンフルエンス
- 主要通貨ペア・時間足の切替
- ティック風のライブ更新（サンプル気配データ）

## 開発

```bash
npm install
npm run dev
```

本番ビルド:

```bash
npm run build
npm run preview
```

## データについて

現在は決定論的なサンプル気配で動作します。実レート API は未接続です。UI 上でもサンプルである旨を表示しています。
