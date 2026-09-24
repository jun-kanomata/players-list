# players-list

📋 Players list ブックマークレットの本体スクリプトを配信するためのリポジトリです。
This repository delivers the script of the Players list bookmarklet.

- インストール / Install: https://jun-kanomata.github.io/bookmarklet/
- 配信 / CDN: https://cdn.jsdelivr.net/gh/jun-kanomata/players-list@main/players.js

ソースは別のリポジトリで管理しており、ここには同期したコピーだけを置いています。
ブックマークレットは通常 jun-kanomata.github.io から本体を読み込み、サイトの制限（Content Security Policy）で読み込めない場合にこのリポジトリ（jsDelivr経由）を使います。

The source is maintained in another repository; this one only holds a synced copy.
The bookmarklet loads the script from jun-kanomata.github.io and falls back to this repository via jsDelivr when a site's Content Security Policy blocks it.
