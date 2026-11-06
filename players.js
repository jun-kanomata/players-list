// 📋 Players list ブックマークレット本体。
// ローダー（bookmarklet/index.html のリンク）から読み込まれ、対応サイトの試合ページから
// ホーム/アウェイの選手名・背番号を取り出して、Tacticalista の配置用TSVとしてコピーする。
// Jリーグ公式とWEリーグのリーグ戦では、JPlayers に取り込むJSONもコピーできる（docs/lineup-json-spec.md）。
//
// 対応サイト: Google検索の試合情報（スタメンタブ） / Jリーグ公式 / スポーツナビ / WEリーグ
//
// 出力形式（Tacticalista FormationManager.placeAllPlayersFromList が読む形。変える時は両方を合わせる）:
//   ###home\t<フォーメーション>
//   <選手名>\t<背番号>      ← 先頭11行がスタメン、以降が控え
//   ###away\t<フォーメーション>
//   <選手名>\t<背番号>
//
// ローダーは毎回 ?t=時刻 付きで jun-kanomata.github.io から読み込むため、pushすると次の実行から反映される。
// ただしJリーグ公式はCSPで github.io を禁止しており、ローダーは公開リポジトリ jun-kanomata/players-list の
// コピーを jsDelivr から読み込む。変更後は sync-players-list.sh で公開リポジトリへ同期すること。
(() => {
  "use strict";

  const HOST_ID = "jk-players-list";
  const VERSION = "2026.11.06";

  // Tacticalista の11人制フォーメーション（util/Formation.ts footballFormations）と同じ並び
  const FORMATIONS = [
    "4-4-2", "4-4-1-1", "4-2-2-2", "4-2-3-1", "4-2-4", "4-1-4-1", "4-1-2-3", "4-3-1-2",
    "4-3-2-1", "4-5-1", "3-4-2-1", "3-4-1-2", "3-2-2-3", "3-3-3-1", "3-5-2", "3-5-1-1",
    "5-3-2", "5-3-1-1", "5-4-1", "2-3-5"
  ];
  // Tacticalista に無い表記は近い形へ寄せる（Tacticalista側 placePlayersWithSystem と同じ変換）
  const FORMATION_ALIASES = {
    "4-3-3": "4-1-2-3",
    "3-4-3": "3-4-2-1",
    "3-1-4-2": "3-5-2",
    "4-1-2-1-2": "4-3-1-2"
  };
  const DEFAULT_FORMATION = "4-4-2";

  // 画面に出すエラー。日英併記で表示する
  class UserError extends Error {
    constructor(ja, en) {
      super(en);
      this.ja = ja;
      this.en = en;
    }
  }

  const clean = (value) => (value || "").replace(/[\s　]+/g, " ").trim();
  const textOf = (root, selector) => {
    const el = root.querySelector(selector);
    return el ? clean(el.textContent) : "";
  };
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const findFormation = (value) => {
    const m = (value || "").match(/\d+(?:-\d+)+/);
    return m ? m[0] : null;
  };
  // extra はJSON用の情報（position, id）。TSVは name と num だけを使う
  const player = (name, num, extra) => ({ name: clean(name), num: clean(num), ...extra });
  const side = (name, formation, starters, subs) => ({
    name: clean(name) || null,
    formation: formation || null,
    starters,
    subs
  });

  // 「GK 1」のような掲載の区分を読む。掲載がなければ null
  const lineupPosition = (value) => {
    const m = clean(value).match(/^(GK|DF|MF|FW)(?:\s|$)/);
    return m ? m[1] : null;
  };
  // 要素自身か配下のリンク /player/{id}/ からIDを読む。リンクがなければ null
  const playerLinkId = (el) => {
    const link = el.matches("a[href]") ? el : el.querySelector("a[href]");
    const m = link ? (link.getAttribute("href") || "").match(/\/player\/(\d+)(?:\/|$)/) : null;
    return m ? m[1] : null;
  };

  // root 配下のテキストを文書順に集める。exclude に当たる要素（ポップアップ等）の中は飛ばす
  function collectTexts(root, exclude) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const hit = node.parentElement && node.parentElement.closest(exclude);
        return hit && root.contains(hit) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const texts = [];
    while (walker.nextNode()) {
      const t = clean(walker.currentNode.textContent);
      if (t) texts.push(t);
    }
    return texts;
  }

  async function fetchDocument(url) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) {
      throw new UserError(
        "メンバー情報のページを取得できませんでした（HTTP " + res.status + "）",
        "Failed to load the lineup page (HTTP " + res.status + ")"
      );
    }
    return new DOMParser().parseFromString(await res.text(), "text/html");
  }

  // ---- Google検索の試合情報（スタメンタブ） ----
  // 選手カード .lrvl-pd は「評価/年齢/国名」の表示ごとに3組あるため、表示中の22枚だけ使う。
  // ピッチ図は .lr-vl-ls がホーム・アウェイの2面で、ホームはGKから、アウェイはFWから並ぶ。
  function parseGoogle() {
    const cards = [...document.querySelectorAll(".lrvl-pd")].filter(isVisible);
    if (cards.length < 22) {
      throw new UserError(
        "スタメンが見つかりません。試合情報を開き「スタメン」タブを表示してから実行してください。",
        "Lineups not found. Open the match details and show the Lineups tab first."
      );
    }
    const halves = [...document.querySelectorAll(".lr-vl-ls")].filter(isVisible);
    let homeCards = halves.length === 2 ? cards.filter((c) => halves[0].contains(c)) : [];
    let awayCards = halves.length === 2 ? cards.filter((c) => halves[1].contains(c)).reverse() : [];
    if (homeCards.length !== 11 || awayCards.length !== 11) {
      homeCards = cards.slice(0, 11);
      awayCards = cards.slice(11, 22).reverse();
    }
    const bench = parseGoogleBench(halves[0] || cards[0]);
    return {
      home: side(textOf(document, "#lrvl_ht"), googleFormation(true, halves),
        homeCards.map(parseGoogleCard), bench.home),
      away: side(textOf(document, "#lrvl_at"), googleFormation(false, halves),
        awayCards.map(parseGoogleCard), bench.away)
    };
  }

  // 背番号はカードの aria-label「#1、谷晃生、10 点中 4.5 点の評価」（英語UIは "#1, Name, ..."）から読む。
  // この形は評価/年齢/国名のどの表示でも同じ。名前はピッチ上の表記（「I. ドレシェヴィッチ」）を優先する
  function parseGoogleCard(card) {
    let num = "";
    let fullName = "";
    for (const el of card.querySelectorAll("[aria-label]")) {
      if (el.closest("g-dialog, g-dialog-content")) continue;
      const m = el.getAttribute("aria-label").match(/^#\s*(\d+)\s*[、,，]\s*([^、,，]+)/);
      if (m) {
        num = m[1];
        fullName = m[2];
        break;
      }
    }
    // 表示テキスト: 評価点（role=status）とポップアップを除いた最後の非数値が名前、その直前の数字が背番号
    const texts = collectTexts(card, "g-dialog, g-dialog-content, style, [role='status']");
    let label = "";
    for (let i = texts.length - 1; i >= 0; i--) {
      if (/^[\d.]+$/.test(texts[i])) continue;
      label = texts[i];
      if (!num && i > 0 && /^\d+$/.test(texts[i - 1])) num = texts[i - 1];
      break;
    }
    return player(label ? shortenInitial(label) : shortenBenchName(fullName), num);
  }

  // ピッチ上の略記「I. ドレシェヴィッチ」はイニシャルを落とす
  function shortenInitial(raw) {
    const parts = clean(raw).split(".");
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.trim().length > 1) return part.trim();
      }
    }
    return parts[0].trim();
  }

  // ベンチのフルネーム「トーマス・ウーワイアン」はピッチ上の表記に合わせて姓だけにする
  function shortenBenchName(raw) {
    const parts = clean(raw).split("・");
    if (parts.length >= 2) {
      const last = parts.length - 1;
      if (parts[last].length === 1) return parts.join("").trim();
      if (parts[last - 1] === "アル") return parts[last - 1] + "・" + parts[last];
      return parts[last].trim();
    }
    const dotParts = parts[0].split(".");
    if (dotParts.length > 1 && dotParts[0].trim().length === 1) return dotParts[1].trim();
    return dotParts[0].trim();
  }

  // ベンチはピッチ図と同じブロックにある表（左列=ホーム、右列=アウェイ）。
  // 背番号は画面に出ず、選手ポップアップ（非表示DOM）の「町田 #2」から読む。
  // 同じブロックの監督・凡例の表には背番号が無いので、#番号を含む最初の表をベンチとみなす。
  function parseGoogleBench(anchor) {
    const bench = { home: [], away: [] };
    let scope = anchor;
    while (scope && ![...scope.querySelectorAll("table")].some(isVisible)) scope = scope.parentElement;
    if (!scope) return bench;
    const table = [...scope.querySelectorAll("table")]
      .filter(isVisible)
      .find((t) => /#\s*\d+/.test(t.textContent));
    if (!table) return bench;
    table.querySelectorAll("tr").forEach((tr) => {
      const cells = tr.querySelectorAll(":scope > td");
      const home = cells[0] && parseGoogleBenchCell(cells[0]);
      const away = cells[1] && parseGoogleBenchCell(cells[1]);
      if (home) bench.home.push(home);
      if (away) bench.away.push(away);
    });
    return bench;
  }

  function parseGoogleBenchCell(td) {
    const labelled = td.querySelector("[role='text'][aria-label]");
    let name = labelled ? labelled.getAttribute("aria-label") : "";
    if (!name) {
      // 評価点・交代時刻（82'）・ポップアップを除いた最初のテキストが名前
      name = collectTexts(td, "g-dialog, g-dialog-content, style, [role='status']")
        .find((t) => !/^[\d.]+$/.test(t) && !/^\d+'/.test(t)) || "";
    }
    if (!name) return null;
    const m = td.textContent.match(/(?:No\.|#)\s*(\d+)/);
    return player(shortenBenchName(name), m ? m[1] : "");
  }

  function googleFormation(isHome, halves) {
    const labels = [...document.querySelectorAll(
      "[aria-label*='フォーメーション'], [aria-label*='Formation'], [aria-label*='formation']"
    )]
      .filter(isVisible)
      .map((el) => findFormation(el.getAttribute("aria-label")))
      .filter(Boolean);
    if (labels.length >= 2) return labels[isHome ? 0 : 1];
    const headers = [...document.querySelectorAll(".lr-vl-hf .lrvl-f")]
      .filter(isVisible)
      .map((el) => findFormation(el.textContent))
      .filter(Boolean);
    if (headers.length >= 2) return headers[isHome ? 0 : 1];
    // ピッチ図の列ごとの人数から組み立てる（GKの列を除く）
    const half = halves[isHome ? 0 : 1];
    if (!half) return null;
    const lines = [...half.querySelectorAll(".lrvl-fr")]
      .map((row) => row.querySelectorAll(".lrvl-pd").length)
      .filter(Boolean);
    if (!isHome) lines.reverse();
    lines.shift();
    return lines.length >= 2 ? lines.join("-") : null;
  }

  // ---- Jリーグ公式（試合ページ） ----
  // メンバー一覧はラインナップタブ表示中だけDOMにあるため、他のタブでは
  // サーバー描画される /lineup/ ページを取得して読む。
  const JL_STARTING = ".p-game-details-lineup-tab__starting-members .m-lineup-list__members";
  const JL_RESERVE = ".p-game-details-lineup-tab__reserve-members .m-lineup-list__members";

  // 公式サイトはReactのストリーミングで描画し、インラインスクリプトの $RS("S:x","P:y") で
  // 内容を差し込み位置へ移す。取得したHTMLではスクリプトが動かないので、同じ移動をここで行う。
  // J2・J3などでは、これをしないと一覧が <section> の外に残りセレクタが一致しない
  function applyStreamedSegments(doc) {
    const scripts = [...doc.querySelectorAll("script")].map((script) => script.textContent).join("\n");
    for (const m of scripts.matchAll(/\$RS\("([^"]+)","([^"]+)"\)/g)) {
      const segment = doc.getElementById(m[1]);
      const slot = doc.getElementById(m[2]);
      if (!segment || !slot || !slot.parentNode) continue;
      segment.remove();
      while (segment.firstChild) slot.parentNode.insertBefore(segment.firstChild, slot);
      slot.remove();
    }
  }

  async function parseJleague() {
    let doc = document;
    if (!doc.querySelector(JL_STARTING)) {
      const m = location.pathname.match(/^\/match\/[^/]+\/\d{4}\/\d+\//);
      if (!m) throw unsupportedPage();
      doc = await fetchDocument(m[0] + "lineup/");
      applyStreamedSegments(doc);
    }
    const starters = jleagueMembers(doc, JL_STARTING);
    if (!starters.length) throw lineupNotAnnounced();
    const reserves = jleagueMembers(doc, JL_RESERVE);
    const build = (isHome) => {
      const key = isHome ? "home" : "away";
      return side(
        jleagueClubName(doc, key),
        findFormation(textOf(doc, ".o-formation__team-info--" + key)) ||
          findFormation(textOf(doc, ".o-formation__mobile-team-info--" + key)),
        starters.filter((p) => p.home === isHome).map((p) => player(p.name, p.num)),
        reserves.filter((p) => p.home === isHome).map((p) => player(p.name, p.num))
      );
    };
    return { home: build(true), away: build(false) };
  }

  // 2カラム（左=ホーム、右=アウェイ）を交互に並べたDOM。
  // 画面上で2列に並んでいれば位置で、そうでなければ（取得したHTML・1列表示）DOM順の偶奇で判定する
  function jleagueMembers(doc, selector) {
    const list = doc.querySelector(selector);
    if (!list) return [];
    const items = [...list.children];
    const lefts = doc === document
      ? items.map((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 ? Math.round(rect.left) : null;
      })
      : [];
    const columns = [...new Set(lefts.filter((v) => v !== null))];
    const byLayout = columns.length === 2;
    const homeLeft = Math.min(...columns);
    return items
      .map((item, i) => {
        const name = textOf(item, ".m-lineup-list-item__name");
        const label = textOf(item, ".m-lineup-list-item__position");
        const num = (label.match(/\d+/) || [""])[0];
        if (!name) return null;
        const home = byLayout && lefts[i] !== null ? lefts[i] === homeLeft : i % 2 === 0;
        return { name, num, home, position: lineupPosition(label), id: playerLinkId(item) };
      })
      .filter(Boolean);
  }

  function jleagueClubName(doc, key) {
    const el = doc.querySelector(".m-lineup-list__club--" + key + " .m-lineup-list__club-name");
    if (!el) return "";
    // 正式名称と略称が並んで入っているので、子要素があれば最初の1つ（正式名称）を使う
    return clean((el.firstElementChild || el).textContent);
  }

  // ---- スポーツナビ（試合ページ） ----
  // 「背番号」「選手名」列を持つ表が ホーム先発・アウェイ先発・ホーム控え・アウェイ控え の順に並ぶ。
  // 表が無いタブでは試合トップ（/summary）を取得して読む。
  async function parseSportsnavi() {
    let doc = document;
    if (sportsnaviTables(doc).length < 2) {
      const m = location.pathname.match(/^(.*\/game\/\d+)/);
      if (!m) throw unsupportedPage();
      doc = await fetchDocument(m[1] + "/summary");
    }
    const tables = sportsnaviTables(doc);
    if (tables.length < 2) throw lineupNotAnnounced();
    const build = (isHome) => {
      const key = isHome ? "home" : "away";
      const starters = tables[isHome ? 0 : 1];
      const subs = tables[isHome ? 2 : 3];
      return side(
        textOf(doc, ".sc-formation__team--" + key + " .sc-formation__teamName"),
        findFormation(textOf(doc, ".sc-formation__team--" + key + " .js-changeFormation")),
        sportsnaviRows(starters),
        subs ? sportsnaviRows(subs) : []
      );
    };
    return { home: build(true), away: build(false) };
  }

  function sportsnaviTables(doc) {
    return [...doc.querySelectorAll("table")].filter((table) => {
      const head = table.querySelector("tr");
      const label = head ? head.textContent : "";
      return /背番号/.test(label) && /選手名/.test(label);
    });
  }

  // Pos.列は rowspan で縦に結合されるため、2行目以降は左のセルが欠けて列位置がずれる。
  // セルのクラスで探し、無ければ欠けた数だけ見出しの位置を補正する
  function sportsnaviRows(table) {
    const rows = [...table.querySelectorAll("tr")];
    const headers = [...rows[0].children].map((cell) => clean(cell.textContent));
    const numIndex = headers.indexOf("背番号");
    const nameIndex = headers.indexOf("選手名");
    return rows
      .slice(1)
      .map((row) => {
        const cells = row.children;
        const offset = headers.length - cells.length;
        const nameCell = row.querySelector(".sc-tableSplits__data--name") || cells[nameIndex - offset];
        const numCell = row.querySelector(".sc-tableSplits__data--number") || cells[numIndex - offset];
        if (!nameCell) return null;
        const name = clean((nameCell.querySelector("a") || nameCell).textContent);
        const num = numCell ? clean(numCell.textContent) : "";
        return name ? player(name, /^\d+$/.test(num) ? num : "") : null;
      })
      .filter(Boolean);
  }

  // ---- WEリーグ（試合ページ） ----
  // 「先発」「控え」の表で、各行の左3列（ポジション・背番号・選手名）がホーム、右3列がアウェイ。
  // フォーメーションは掲載されていない。
  function parseWeleague() {
    const blocks = [...document.querySelectorAll(".table-inner")];
    const block = (title) => blocks.find((b) => clean(b.firstElementChild && b.firstElementChild.textContent) === title);
    const starters = weleagueRows(block("先発"));
    const subs = weleagueRows(block("控え"));
    if (!starters.home.length && !starters.away.length) throw lineupNotAnnounced();
    const names = document.querySelectorAll(".team-name._full");
    return {
      home: side(names[0] && names[0].textContent, null, starters.home, subs.home),
      away: side(names[1] && names[1].textContent, null, starters.away, subs.away)
    };
  }

  function weleagueRows(block) {
    const rows = { home: [], away: [] };
    if (!block) return rows;
    const read = (positionCell, numCell, nameCell) => {
      if (!numCell || !nameCell) return null;
      const nameEl = nameCell.querySelector(".name") || nameCell;
      const name = clean(nameEl.textContent);
      if (!name) return null;
      return player(name, numCell.textContent, {
        position: positionCell ? lineupPosition(positionCell.textContent) : null,
        id: playerLinkId(nameEl)
      });
    };
    block.querySelectorAll(".table-inner-flex").forEach((row) => {
      const cols = row.children;
      if (cols.length < 6) return;
      const home = read(cols[0], cols[1], cols[2]);
      const away = read(cols[cols.length - 3], cols[cols.length - 2], cols[cols.length - 1]);
      if (home) rows.home.push(home);
      if (away) rows.away.push(away);
    });
    return rows;
  }

  // ---- ラインナップJSON（docs/lineup-json-spec.md） ----
  const LINEUP_TYPE = "match-lineup";
  const LINEUP_VERSION = 1;
  const JLEAGUE_PLAYER_SCHEME = "jleague-player";
  const WELEAGUE_PLAYER_SCHEME = "weleague-web-profile";
  const JLEAGUE_PLACEMENT_SCHEME = "jleague-pitch-v1";
  const KICKOFF_TIME = "前半0分";
  const STARTERS_COUNT = 11;

  // Jリーグ公式の試合ページにはシーズンの記載がないため、大会名と試合日を開催期間と照合する。
  // シーズンが変わるたびに追記する。追記するまで新シーズンの試合はJSONを出力しない
  const JLEAGUE_SEASONS = [
    {
      id: "2026-27",
      name: "2026/27",
      competitions: [
        { label: "明治安田J1リーグ", id: "J1", from: "2026-08-07", to: "2027-06-06" },
        { label: "明治安田J2リーグ", id: "J2", from: "2026-08-08", to: "2027-05-23" },
        { label: "明治安田J3リーグ", id: "J3", from: "2026-08-08", to: "2027-05-23" }
      ]
    }
  ];

  const nfkc = (value) => clean(value).normalize("NFKC");
  const pad2 = (value) => String(value).padStart(2, "0");

  function matchUrlError() {
    return new UserError(
      "試合ページのURLを確認できないため、JSONを作成できません。",
      "The match page URL could not be identified, so JSON is unavailable."
    );
  }

  function seasonUnknownError() {
    return new UserError(
      "大会・シーズンを確認できないため、JSONを作成できません。",
      "The competition or season could not be confirmed, so JSON is unavailable."
    );
  }

  function unsupportedCompetitionError(label) {
    return new UserError(
      "「" + label + "」はJSONの対象外です。",
      "JSON is not available for \"" + label + "\"."
    );
  }

  async function fetchLineupDocument(url) {
    let res;
    try {
      res = await fetch(url, { credentials: "same-origin" });
    } catch (e) {
      throw new UserError(
        "ラインナップページを取得できませんでした。",
        "Failed to load the lineup page."
      );
    }
    if (!res.ok) {
      throw new UserError(
        "ラインナップページを取得できませんでした（HTTP " + res.status + "）",
        "Failed to load the lineup page (HTTP " + res.status + ")"
      );
    }
    return new DOMParser().parseFromString(await res.text(), "text/html");
  }

  // <title> の「（大会名：2026年8月7日）」から大会名と試合日（日本時間）を読み、対応表で判定する
  function resolveJleagueMatch(doc) {
    const m = (doc.title || "").match(/（([^（）：]+)：(\d{4})年(\d{1,2})月(\d{1,2})日）/);
    if (!m) throw seasonUnknownError();
    const label = clean(m[1]);
    const date = m[2] + "-" + pad2(m[3]) + "-" + pad2(m[4]);
    const normalized = nfkc(label);
    const known = JLEAGUE_SEASONS.flatMap((season) =>
      season.competitions.map((competition) => ({ season, competition })));
    const sameName = known.filter((entry) => entry.competition.label === normalized);
    if (!sameName.length) throw unsupportedCompetitionError(label);
    const hit = sameName.find((entry) => entry.competition.from <= date && date <= entry.competition.to);
    if (!hit) {
      throw new UserError(
        label + "の" + date + "に対応するシーズンを確認できません。",
        "No season could be confirmed for " + label + " on " + date + "."
      );
    }
    return {
      label,
      date,
      competition: { id: hit.competition.id, name: label },
      season: { id: hit.season.id, name: hit.season.name }
    };
  }

  // 取得元の見出し「２０２６／２７ＷＥリーグ 第7節」からシーズンを読む
  function resolveWeleagueMatch() {
    const label = textOf(document, ".result_leg span");
    if (!label) throw seasonUnknownError();
    const m = nfkc(label).match(/^(\d{4})\/(\d{2})\s*(?:\S+\s+)?WEリーグ\s*第\d+節$/);
    if (!m) throw unsupportedCompetitionError(label);
    if ((Number(m[1]) + 1) % 100 !== Number(m[2])) throw seasonUnknownError();
    return {
      label,
      competition: { id: "WE", name: "WEリーグ" },
      season: { id: m[1] + "-" + m[2], name: m[1] + "/" + m[2] }
    };
  }

  // 埋め込みデータ self.__next_f.push([1,"..."]) の文字列を順に連結する
  function readFlightText(doc) {
    const prefix = "self.__next_f.push([1,";
    const suffix = "])";
    const parts = [];
    doc.querySelectorAll("script").forEach((script) => {
      const text = script.textContent.trim().replace(/;$/, "");
      if (text.startsWith(prefix) && text.endsWith(suffix)) {
        parts.push(JSON.parse(text.slice(prefix.length, -suffix.length)));
      }
    });
    return parts.join("");
  }

  // from の位置の [ に対応する ] までを切り出す。文字列の中の括弧は数えない
  function sliceJsonArray(text, from) {
    let depth = 0;
    let inString = false;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === "[") {
        depth++;
      } else if (c === "]" && --depth === 0) {
        return text.slice(from, i + 1);
      }
    }
    return null;
  }

  // キックオフ時点のフォーメーションを返す。読めない・条件を満たさないときは null。
  // 画面のピッチ図はタイムラインの最後の時点なので、先発の配置には使えない
  function readKickoffFormation(doc) {
    try {
      const text = readFlightText(doc);
      const start = text.indexOf('"formations":[{"matchTime"');
      if (start < 0) return null;
      const json = sliceJsonArray(text, start + '"formations":'.length);
      const kickoff = json && JSON.parse(json)[0];
      if (!kickoff || kickoff.matchTime !== KICKOFF_TIME) return null;
      const usable = [kickoff.homeTeam, kickoff.awayTeam].every((team) =>
        team && Array.isArray(team.players) && team.players.length === STARTERS_COUNT &&
        team.players.every((p) => p.playerNumber !== undefined && p.playerNumber !== null &&
          Number.isFinite(p.positionX) && Number.isFinite(p.positionY)));
      return usable ? kickoff : null;
    } catch (e) {
      return null;
    }
  }

  const clubCode = (href) => {
    const m = (href || "").match(/^\/club\/([^/]+)\/?$/);
    return m ? m[1] : null;
  };

  // 埋め込みデータとHTMLのクラブを照合し、一致すれば両チームのコードを返す。
  // リンクはピッチ図の側にしかないので、一覧のチームとは名前で照合する
  function verifyJleagueClubs(doc, kickoff, names) {
    const codes = {};
    for (const key of ["home", "away"]) {
      const team = kickoff[key + "Team"];
      const link = doc.querySelector(".o-formation__team-info--" + key);
      const code = clubCode(link && link.getAttribute("href"));
      if (!code || code !== clubCode(team.teamURL)) return null;
      if (nfkc(team.teamName) !== nfkc(names[key])) return null;
      codes[key] = code;
    }
    return codes;
  }

  function assertStartersCount(home, away) {
    [["ホーム", "Home", home], ["アウェイ", "Away", away]].forEach(([ja, en, team]) => {
      const count = team.starters.length;
      if (count === STARTERS_COUNT) return;
      const verb = count < STARTERS_COUNT ? "人しか確認できない" : "人確認された";
      throw new UserError(
        (team.name || ja) + "の先発を" + count + verb + "ため、JSONを作成できません（11人を想定）。",
        (team.name || en) + ": " + count + " starters found (expected 11), so JSON is unavailable."
      );
    });
  }

  function assertSameStarters(starters, kickoffTeam) {
    const listed = starters.map((p) => p.num).sort();
    const embedded = kickoffTeam.players.map((p) => String(p.playerNumber)).sort();
    // 重複があると背番号で結合したときに別の選手へ同じIDと配置が付くので、一意であることも確かめる
    const unique = (numbers) => new Set(numbers).size === numbers.length;
    const sameNumbers = unique(listed) && unique(embedded) && listed.length === embedded.length &&
      listed.every((num, i) => num === embedded[i]);
    const sameIds = sameNumbers && starters.every((p) => {
      const found = kickoffTeam.players.find((q) => String(q.playerNumber) === p.num);
      return !p.id || found.id === undefined || found.id === null || String(found.id) === p.id;
    });
    if (!sameIds) {
      throw new UserError(
        "ラインナップとフォーメーションの内容が一致しないため、JSONを作成できません。",
        "The lineup and formation data disagree, so JSON is unavailable."
      );
    }
  }

  function lineupPlayer(p, scheme, kickoffPlayer) {
    const embeddedId = kickoffPlayer && kickoffPlayer.id !== undefined && kickoffPlayer.id !== null
      ? String(kickoffPlayer.id)
      : null;
    const id = embeddedId || p.id || null;
    return {
      name: p.name,
      number: /^\d+$/.test(p.num) ? Number(p.num) : null,
      position: p.position || null,
      sourcePlayerId: id ? { scheme, value: id } : null,
      placement: kickoffPlayer ? { x: kickoffPlayer.positionX, y: kickoffPlayer.positionY } : null
    };
  }

  async function buildJleagueLineup() {
    const base = (location.pathname.match(/^(\/match\/[^/]+\/\d{4}\/\d+)(?:\/|$)/) || [])[1];
    if (!base) throw matchUrlError();
    const doc = await fetchLineupDocument(base + "/lineup/");
    applyStreamedSegments(doc);
    const info = resolveJleagueMatch(doc);
    const starters = jleagueMembers(doc, JL_STARTING);
    if (!starters.length) throw lineupNotAnnounced();
    const reserves = jleagueMembers(doc, JL_RESERVE);
    const names = { home: jleagueClubName(doc, "home"), away: jleagueClubName(doc, "away") };
    if (!names.home || !names.away) {
      throw new UserError(
        "チームを確認できないため、JSONを作成できません。",
        "The teams could not be confirmed, so JSON is unavailable."
      );
    }
    const startersOf = (isHome) => starters.filter((p) => p.home === isHome);
    assertStartersCount(
      { name: names.home, starters: startersOf(true) },
      { name: names.away, starters: startersOf(false) }
    );

    const kickoff = readKickoffFormation(doc);
    const codes = kickoff ? verifyJleagueClubs(doc, kickoff, names) : null;
    if (codes) {
      assertSameStarters(startersOf(true), kickoff.homeTeam);
      assertSameStarters(startersOf(false), kickoff.awayTeam);
    }
    const build = (key, isHome) => {
      const team = codes ? kickoff[key + "Team"] : null;
      const byNumber = new Map(team ? team.players.map((p) => [String(p.playerNumber), p]) : []);
      return {
        name: names[key],
        sourceTeamCode: codes ? codes[key] : null,
        formation: (team && team.formation) || null,
        starters: startersOf(isHome).map((p) => lineupPlayer(p, JLEAGUE_PLAYER_SCHEME, byNumber.get(p.num))),
        subs: reserves.filter((p) => p.home === isHome).map((p) => lineupPlayer(p, JLEAGUE_PLAYER_SCHEME))
      };
    };
    return {
      summary: info.label + " " + info.season.name,
      listOnly: !codes,
      json: {
        type: LINEUP_TYPE,
        version: LINEUP_VERSION,
        placementScheme: codes ? JLEAGUE_PLACEMENT_SCHEME : null,
        match: {
          source: "jleague",
          sourceUrl: location.origin + base + "/",
          sourceLabel: info.label,
          date: info.date,
          competition: info.competition,
          season: info.season
        },
        home: build("home", true),
        away: build("away", false)
      }
    };
  }

  // .result_day は年を含まないので、URLの試合IDの日付と月日が一致するときだけ試合日とする
  function weleagueDate(idDate) {
    const m = textOf(document, ".result_day").match(/^(\d{1,2})\/(\d{1,2})(?:\D|$)/);
    if (!m || Number(m[1]) !== Number(idDate.month) || Number(m[2]) !== Number(idDate.day)) return null;
    return idDate.year + "-" + idDate.month + "-" + idDate.day;
  }

  function weleagueClubCode(key) {
    const link = document.querySelector(".nextmatch-" + key + " a[href^='/clubs/']");
    const m = link ? link.getAttribute("href").match(/^\/clubs\/([^/]+)\/?$/) : null;
    return m ? m[1] : null;
  }

  async function buildWeleagueLineup(match) {
    const m = location.pathname.match(/^\/matches\/((\d{4})(\d{2})(\d{2})\d*)(?:\/|$)/);
    if (!m) throw matchUrlError();
    const info = resolveWeleagueMatch();
    assertStartersCount(match.home, match.away);
    const build = (key) => ({
      name: match[key].name,
      sourceTeamCode: weleagueClubCode(key),
      formation: null,
      starters: match[key].starters.map((p) => lineupPlayer(p, WELEAGUE_PLAYER_SCHEME)),
      subs: match[key].subs.map((p) => lineupPlayer(p, WELEAGUE_PLAYER_SCHEME))
    });
    return {
      summary: info.label,
      listOnly: false,
      json: {
        type: LINEUP_TYPE,
        version: LINEUP_VERSION,
        placementScheme: null,
        match: {
          source: "weleague",
          sourceUrl: location.origin + "/matches/" + m[1] + "/",
          sourceLabel: info.label,
          date: weleagueDate({ year: m[2], month: m[3], day: m[4] }),
          competition: info.competition,
          season: info.season
        },
        home: build("home"),
        away: build("away")
      }
    };
  }

  // ---- サイト判定 ----
  const SITES = [
    { host: /(^|\.)google\.[a-z.]+$/, ja: "Google", en: "Google", parse: parseGoogle },
    { host: /(^|\.)jleague\.jp$/, ja: "Jリーグ公式", en: "J.LEAGUE", parse: parseJleague, lineup: buildJleagueLineup },
    { host: /(^|\.)yahoo\.co\.jp$/, ja: "スポーツナビ", en: "Sportsnavi", parse: parseSportsnavi },
    { host: /(^|\.)weleague\.jp$/, ja: "WEリーグ", en: "WE LEAGUE", parse: parseWeleague, lineup: buildWeleagueLineup }
  ];

  function unsupportedPage() {
    return new UserError(
      "このページには対応していません。Google検索の試合情報、Jリーグ公式・スポーツナビ・WEリーグの試合ページで実行してください。",
      "This page is not supported. Run it on a Google match card, or a J.LEAGUE / Sportsnavi / WE LEAGUE match page."
    );
  }

  function lineupNotAnnounced() {
    return new UserError(
      "メンバーが見つかりません。メンバー発表前か、ページの形式が変わった可能性があります。",
      "No lineup found. It may not be announced yet, or the page layout has changed."
    );
  }

  // ---- TSV ----
  function resolveFormation(raw) {
    if (!raw) return { value: DEFAULT_FORMATION, state: "missing" };
    const mapped = FORMATION_ALIASES[raw] || raw;
    if (FORMATIONS.includes(mapped)) return { value: mapped, state: mapped === raw ? "detected" : "mapped", raw };
    return { value: DEFAULT_FORMATION, state: "unsupported", raw };
  }

  function buildTsv(match, options) {
    const rows = (team) => (options.startersOnly ? team.starters : team.starters.concat(team.subs))
      .map((p) => p.name + "\t" + p.num + "\n")
      .join("");
    return "###home\t" + options.homeFormation + "\n" + rows(match.home) +
      "###away\t" + options.awayFormation + "\n" + rows(match.away);
  }

  function collectWarnings(match) {
    const warnings = [];
    [["ホーム", "Home", match.home], ["アウェイ", "Away", match.away]].forEach(([ja, en, team]) => {
      if (team.starters.length !== 11) {
        warnings.push([
          ja + "の先発が" + team.starters.length + "人です（11人を想定）",
          en + ": " + team.starters.length + " starters (expected 11)"
        ]);
      }
    });
    const all = [match.home, match.away].flatMap((t) => t.starters.concat(t.subs));
    if (all.some((p) => !p.num || !p.name)) {
      warnings.push([
        "背番号または名前が取れなかった選手がいます。下のプレビューで補ってください。",
        "Some names or numbers are missing. Fill them in the preview below."
      ]);
    }
    return warnings;
  }

  async function copyText(text, fallbackField) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        fallbackField.focus();
        fallbackField.select();
        return document.execCommand("copy");
      } catch (e2) {
        return false;
      }
    }
  }

  // ---- UI ----
  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.panel {
  --bg: #ffffff; --surface: #f3f5f9; --ink: #172645; --sub: #47536b; --faint: #7a859c;
  --line: #c6ccd9; --frame: #172645; --accent: #ff005e; --accent-hover: #e00053;
  --home: #1d5fd1; --away: #d0342c; --warn-bg: #fff4d6; --warn-ink: #6e4a00;
  --err-bg: #ffe9ef; --err-ink: #9c0030; --ok: #0a7d47; --focus: #1d5fd1;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto;
  padding: 14px; background: var(--bg); color: var(--ink);
  border: 2px solid var(--frame); border-radius: 12px;
  box-shadow: 0 8px 32px rgba(23, 38, 69, .3);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif;
  text-align: left; letter-spacing: normal; -webkit-text-size-adjust: 100%;
  animation: rise .18s ease-out;
}
@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #131b2d; --surface: #1c263b; --ink: #e9edf5; --sub: #b3bdd1; --faint: #8390a8;
    --line: #36445f; --frame: #5d6f94; --accent: #ff2e7a; --accent-hover: #ff4d8e;
    --home: #5b93f5; --away: #f06a5f; --warn-bg: #3a2f12; --warn-ink: #f4d27a;
    --err-bg: #3d1622; --err-ink: #ff9ab5; --ok: #3ccf8e; --focus: #7aa8ff;
    box-shadow: 0 8px 32px rgba(0, 0, 0, .5);
  }
}
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
@media (max-width: 480px) {
  .panel { left: 8px; right: 8px; bottom: 8px; width: auto; max-width: none; max-height: calc(100vh - 16px); }
}
button, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.en { color: var(--faint); font-weight: 400; font-size: .85em; }
.bi .en { margin-left: .45em; }
.header { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
.title { font-size: 14px; font-weight: 700; line-height: 1.3; }
.meta { margin-top: 3px; font-size: 11px; color: var(--sub); }
.chip {
  display: inline-block; padding: 0 7px; margin-right: 6px; border: 1px solid var(--line);
  border-radius: 999px; font-size: 10px; line-height: 16px; color: var(--sub);
}
.icon-btn {
  margin-left: auto; flex: none; width: 28px; height: 28px; border: 0; border-radius: 999px;
  background: transparent; color: var(--sub); font-size: 18px; line-height: 28px; cursor: pointer;
}
.icon-btn:hover { background: var(--surface); }
.team {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 10px;
  padding: 8px 10px; background: var(--surface); border-radius: 8px;
}
.team + .team { margin-top: 6px; }
.side {
  padding: 1px 7px; border-radius: 999px; color: #fff;
  font-size: 10px; font-weight: 700; letter-spacing: .06em;
}
.side.home { background: var(--home); }
.side.away { background: var(--away); }
.team-main { min-width: 0; }
.team-name { font-weight: 700; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.team-count { font-size: 11px; color: var(--sub); white-space: nowrap; }
.team-count .en { margin-left: .25em; }
.formation { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
select {
  min-width: 96px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); font-size: 13px; cursor: pointer;
}
.hint { font-size: 10px; line-height: 1.3; color: var(--faint); text-align: right; }
.hint.attention { color: var(--warn-ink); }
.seg { display: flex; gap: 2px; margin: 10px 0 8px; padding: 2px; border: 1px solid var(--line); border-radius: 999px; }
.seg button {
  flex: 1; padding: 5px 8px; border: 0; border-radius: 999px; background: transparent;
  color: var(--sub); cursor: pointer; white-space: nowrap;
}
.seg button[aria-pressed="true"] { background: var(--ink); color: var(--bg); font-weight: 700; }
.seg button[aria-pressed="true"] .en { color: inherit; opacity: .75; }
.notice { margin-bottom: 8px; padding: 6px 9px; border-radius: 6px; font-size: 12px; }
.notice p { margin: 0; }
.notice p + p { margin-top: 4px; }
.notice .en { display: block; color: inherit; opacity: .8; }
.notice.warn { background: var(--warn-bg); color: var(--warn-ink); }
.notice.error { background: var(--err-bg); color: var(--err-ink); font-size: 13px; }
.preview-label { display: flex; justify-content: space-between; margin-bottom: 3px; font-size: 11px; color: var(--sub); }
textarea {
  display: block; width: 100%; height: 150px; resize: vertical; padding: 6px 8px;
  border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre; overflow-wrap: normal; tab-size: 14;
}
/* iOS Safari は16px未満の入力欄にフォーカスすると画面を拡大するため */
@media (pointer: coarse) { textarea, select { font-size: 16px; } }
.actions { display: flex; gap: 8px; margin-top: 10px; }
.btn { padding: 8px 14px; border-radius: 999px; cursor: pointer; }
.btn.primary { flex: 1; border: 0; background: var(--accent); color: #fff; font-weight: 700; }
.btn.primary:hover { background: var(--accent-hover); }
.btn.primary .en { color: inherit; opacity: .85; }
.btn.primary.done { background: var(--ok); }
.btn.secondary { border: 1px solid var(--line); background: var(--bg); color: var(--sub); }
.btn.secondary:hover { background: var(--surface); }
.btn:disabled { opacity: .55; cursor: default; }
.btn.secondary:disabled:hover { background: var(--bg); }
.btn.secondary.done { border-color: var(--ok); color: var(--ok); }
.json-row { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.json-head { display: flex; align-items: center; gap: 8px; }
.json-summary { flex: 1; min-width: 0; font-size: 12px; font-weight: 700; }
.json-note { margin-top: 4px; font-size: 11px; color: var(--sub); }
.json-row .notice { margin: 8px 0 0; }
/* クリップボードAPIが使えないときに選択してコピーするため、display: none にしない */
.offscreen { position: fixed; top: 0; left: -9999px; width: 1px; height: 1px; opacity: 0; resize: none; }
.footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 10px; color: var(--faint); }
.loading { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--sub); }
.spinner {
  width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent);
  border-radius: 50%; animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
`;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    }
    el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  // 日本語を主に、英語を小さく添える
  const bi = (ja, en) => h("span", { class: "bi" }, ja, h("span", { class: "en" }, en));
  const fill = (el, ...children) => el.replaceChildren(...children.flat().filter(Boolean));

  function mountPanel() {
    const old = document.getElementById(HOST_ID);
    if (old) old.remove();
    const host = h("div", { id: HOST_ID });
    const root = host.attachShadow({ mode: "open" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.append(h("style", null, CSS));
    }
    const panel = h("div", { class: "panel", role: "dialog", "aria-label": "Players list" });
    root.append(panel);

    const onDocKey = (e) => {
      if (e.key === "Escape") close();
    };
    const close = () => {
      host.remove();
      document.removeEventListener("keydown", onDocKey, true);
    };
    // パネル内のキー入力をページ側のショートカット（Googleの「/」で検索欄へ等）に渡さない
    ["keydown", "keyup", "keypress"].forEach((type) => {
      host.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "keydown" && e.key === "Escape") close();
      });
    });
    document.addEventListener("keydown", onDocKey, true);
    (document.body || document.documentElement).append(host);
    return { panel, close };
  }

  function header(ui, site, subtitle) {
    return h("div", { class: "header" },
      h("div", null,
        h("div", { class: "title" }, "📋 ", bi("メンバー取得", "Players list")),
        h("div", { class: "meta" },
          site ? h("span", { class: "chip" }, site.ja === site.en ? site.ja : site.ja + " / " + site.en) : null,
          subtitle || null)
      ),
      h("button", { class: "icon-btn", type: "button", title: "閉じる / Close", "aria-label": "Close", onclick: ui.close }, "×")
    );
  }

  function renderLoading(ui, site) {
    fill(ui.panel,
      header(ui, site),
      h("div", { class: "loading" }, h("span", { class: "spinner" }), bi("読み込み中…", "Loading…"))
    );
  }

  function renderError(ui, site, error) {
    const ja = error instanceof UserError ? error.ja : "取得中にエラーが発生しました。ページの形式が変わった可能性があります。";
    const en = error instanceof UserError ? error.en : "Something went wrong. The page layout may have changed.";
    const detail = error instanceof UserError ? null : String(error && error.message || error);
    fill(ui.panel,
      header(ui, site),
      h("div", { class: "notice error", role: "alert" },
        h("p", null, ja, h("span", { class: "en" }, en)),
        detail ? h("p", { class: "en" }, detail) : null),
      h("div", { class: "actions" },
        h("button", { class: "btn secondary", type: "button", onclick: ui.close }, bi("閉じる", "Close")))
    );
  }

  function attachCopy(button, label, copy) {
    let resetTimer = null;
    button.addEventListener("click", async () => {
      const ok = await copy();
      clearTimeout(resetTimer);
      button.classList.toggle("done", ok);
      button.replaceChildren(ok ? bi("コピーしました ✓", "Copied") : bi("コピーできませんでした", "Copy failed"));
      resetTimer = setTimeout(() => {
        button.classList.remove("done");
        button.replaceChildren(label());
      }, 2200);
    });
  }

  // JSONの組み立ては非同期に行い、成否はTSVの操作に影響させない
  function lineupRow(site, match) {
    if (!site.lineup) return null;
    const label = () => bi("JSONをコピー", "Copy JSON");
    const field = h("textarea", {
      class: "offscreen", readonly: true, tabindex: "-1", "aria-hidden": "true", wrap: "off"
    });
    const button = h("button", { class: "btn secondary", type: "button", disabled: true }, label());
    const summary = h("div", { class: "json-summary" }, bi("確認中…", "Checking…"));
    const details = h("div", { role: "status" });
    attachCopy(button, label, async () => {
      const ok = await copyText(field.value, field);
      button.focus({ preventScroll: true });
      return ok;
    });

    const notice = (ja, en) => h("div", { class: "notice warn" },
      h("p", null, ja, h("span", { class: "en" }, en)));
    (async () => {
      try {
        const lineup = await site.lineup(match);
        field.value = JSON.stringify(lineup.json, null, 2);
        button.disabled = false;
        fill(summary, lineup.summary);
        fill(details,
          lineup.listOnly
            ? notice("フォーメーションと配置を取得できませんでした。", "Formations and positions could not be read.")
            : null,
          h("div", { class: "json-note" },
            bi("JPlayersに貼り付けて取り込み。上の選択や編集は反映されません",
              "Paste into JPlayers. Choices and edits above are not applied.")));
      } catch (error) {
        if (!(error instanceof UserError)) console.error("[Players list]", error);
        const known = error instanceof UserError;
        fill(summary, "JSON");
        fill(details, notice(
          known ? error.ja : "JSONを作成できませんでした。ページの形式が変わった可能性があります。",
          known ? error.en : "JSON is unavailable. The page layout may have changed."));
      }
    })();
    return h("div", { class: "json-row" },
      h("div", { class: "json-head" }, summary, button),
      details,
      field);
  }

  function renderResult(ui, site, match) {
    const state = {
      startersOnly: false,
      home: resolveFormation(match.home.formation),
      away: resolveFormation(match.away.formation)
    };
    const preview = h("textarea", { spellcheck: "false", "aria-label": "TSV preview", wrap: "off" });
    const refresh = () => {
      preview.value = buildTsv(match, {
        startersOnly: state.startersOnly,
        homeFormation: state.home.value,
        awayFormation: state.away.value
      });
    };

    const teamRow = (key) => {
      const team = match[key];
      const formation = state[key];
      const select = h("select", {
        "aria-label": (key === "home" ? "Home" : "Away") + " formation",
        onchange: (e) => {
          formation.value = e.target.value;
          refresh();
        }
      }, FORMATIONS.map((f) => h("option", { value: f, selected: f === formation.value }, f)));
      const hints = {
        detected: "自動検出 / auto",
        mapped: formation.raw + " → " + formation.value,
        missing: "未検出 / not found",
        unsupported: formation.raw + " 未対応 / unsupported"
      };
      return h("div", { class: "team" },
        h("span", { class: "side " + key }, key === "home" ? "HOME" : "AWAY"),
        h("div", { class: "team-main" },
          h("div", { class: "team-name", title: team.name || "" },
            team.name || (key === "home" ? "ホーム" : "アウェイ")),
          h("div", { class: "team-count" },
            "先発", h("span", { class: "en" }, "XI"), " " + team.starters.length + " · 控え",
            h("span", { class: "en" }, "Subs"), " " + team.subs.length)),
        h("div", { class: "formation" },
          select,
          h("span", { class: "hint" + (formation.state === "detected" ? "" : " attention") },
            hints[formation.state]))
      );
    };

    const allBtn = h("button", { type: "button", "aria-pressed": "true" },
      bi("全員", "All " + (match.home.starters.length + match.home.subs.length) + "+" +
        (match.away.starters.length + match.away.subs.length)));
    const xiBtn = h("button", { type: "button", "aria-pressed": "false" }, bi("先発のみ", "Starting XI"));
    const setMode = (startersOnly) => {
      state.startersOnly = startersOnly;
      allBtn.setAttribute("aria-pressed", String(!startersOnly));
      xiBtn.setAttribute("aria-pressed", String(startersOnly));
      refresh();
    };
    allBtn.addEventListener("click", () => setMode(false));
    xiBtn.addEventListener("click", () => setMode(true));

    const warnings = collectWarnings(match);
    const copyLabel = () => bi("TSVをコピー", "Copy TSV");
    const copyBtn = h("button", { class: "btn primary", type: "button" }, copyLabel());
    attachCopy(copyBtn, copyLabel, () => copyText(preview.value, preview));

    const title = match.home.name && match.away.name ? match.home.name + " vs " + match.away.name : null;
    fill(ui.panel,
      header(ui, site, title),
      warnings.length
        ? h("div", { class: "notice warn", role: "status" },
          warnings.map(([ja, en]) => h("p", null, ja, h("span", { class: "en" }, en))))
        : null,
      teamRow("home"),
      teamRow("away"),
      h("div", { class: "seg", role: "group", "aria-label": "Players to copy" }, allBtn, xiBtn),
      h("div", { class: "preview-label" }, bi("プレビュー（編集できます）", "Preview, editable")),
      preview,
      h("div", { class: "actions" },
        copyBtn,
        h("button", { class: "btn secondary", type: "button", onclick: ui.close }, bi("閉じる", "Close"))),
      lineupRow(site, match),
      h("div", { class: "footer" },
        bi("Tacticalistaに貼り付けて配置", "Paste into Tacticalista"),
        h("span", null, "v" + VERSION))
    );
    refresh();
    copyBtn.focus({ preventScroll: true });
  }

  async function main() {
    const site = SITES.find((s) => s.host.test(location.hostname)) || null;
    const ui = mountPanel();
    if (!site) {
      renderError(ui, null, unsupportedPage());
      return;
    }
    renderLoading(ui, site);
    try {
      renderResult(ui, site, await site.parse());
    } catch (error) {
      if (!(error instanceof UserError)) console.error("[Players list]", error);
      renderError(ui, site, error);
    }
  }

  main();
})();
