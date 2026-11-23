(function feltNotes() {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const root = $("#main"),
    dialog = $("#dialog"),
    modal = $("#modal-body"),
    native = window.FeltNative;
  const engine = window.PokerEngine;
  const vision = window.BoardVision;
  const inboxId = engine.inboxId;
  // Photos are compressed on this device and kept beside the book, never sent anywhere.
  const PHOTO = Object.freeze({
    side: 1600, // longest edge of the stored copy
    thumb: 360,
    quality: 0.8,
    maxBytes: 2 * 1024 * 1024, // per stored photo
    maxInput: 40 * 1024 * 1024, // per picked file
    maxPixels: 80e6,
  });
  const MAX_BACKUP_BYTES = 300 * 1024 * 1024;
  const photoKey = (id) => "photo:" + id;
  const photoIdPattern = /^[A-Za-z0-9-]{8,80}$/;
  const cardPattern = /^[2-9TJQKA][shdc]$/;
  const roster = (data = book) => data.players.filter((p) => p.id !== inboxId);
  const suits = { s: "♠", h: "♥", d: "♦", c: "♣" },
    suitNames = { s: "黑桃", h: "红桃", d: "方块", c: "梅花" };
  const ranks = "AKQJT98765432".split("");
  const groups = {
    heroCards: ["我的底牌", 2],
    villainCards: ["对手亮牌", 2],
    board: ["公共牌", 5],
  };
  const streets = ["综合", "翻前", "翻牌", "转牌", "河牌", "摊牌"];
  const glyphs = {
    book: "M4 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-2H4z M13 7a3 3 0 0 1 3-3h4v14h-4a3 3 0 0 0-3 2",
    users:
      "M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M20 20v-2a4 4 0 0 0-3-4 M13 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M16 4a3 3 0 0 1 0 6",
    time: "M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    export: "M12 15V3 M8 7l4-4 4 4 M5 14v6h14v-6",
    plus: "M12 5v14 M5 12h14",
    edit: "m4 16 11-11 4 4L8 20l-5 1z M13.5 6.5l4 4",
    search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    chev: "m9 6 6 6-6 6",
    back: "m14 6-6 6 6 6",
    x: "m6 6 12 12 M18 6 6 18",
    copy: "M9 9h11v11H9z M15 6V3H3v12h3",
    download: "M12 3v12 m-5-5 5 5 5-5 M4 16v4h16v-4",
    cards: "M9 3h10v16H9z M6 6l-3 1 3 14 7-2",
    trash: "M3 6h18 M9 6V3h6v3 M6 6l1 14h10l1-14",
    note: "M4 4h16v12l-4 4H4z M8 9h8 M8 13h5",
    camera: "M4 8h3l2-3h6l2 3h3v11H4z M15.5 13a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0",
  };
  const icon = (k) =>
    `<svg class="ic" aria-hidden="true" viewBox="0 0 24 24"><path d="${glyphs[k] || glyphs.note}"/></svg>`;
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const uid = () =>
    crypto.randomUUID?.() ||
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join("");
  const now = () => new Date().toISOString();
  const label = (t) => engine.tags.find((x) => x.id === t)?.label || t;
  const fmt = (
    s,
    opts = {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  ) => new Date(s).toLocaleString("zh-CN", opts);
  const shortDate = (s) => fmt(s, { month: "numeric", day: "numeric" });
  const button = (s, a, k = "", cls = "outline", id = "") =>
    `<button type="button" class="btn ${cls}" data-action="${a}" data-id="${esc(id)}">${k ? icon(k) : ""}${esc(s)}</button>`;
  const navs = [
    ["notes", "edit", "桌边笔记"],
    ["players", "users", "牌手档案"],
    ["export", "export", "复盘导出"],
  ];
  const selState = {
    page: "notes",
    id: null,
    query: "",
    filter: "",
    noteQuery: "",
    tab: "history",
    days: 7,
  };
  const emptyBook = () => ({ format: "felt-notes", version: 1, players: [] });
  let book = emptyBook(),
    database,
    ready = false,
    nativeQueue = Promise.resolve(),
    focusBefore = null,
    toastTimeout;
  let offlineStatus = "正在准备离线使用…";
  let storageRequested = false;
  let pendingImport = null,
    newTags = new Set(),
    draftCards = null,
    cardPicker = null,
    editorGroups = null, // limit the card editor to some groups (board-only sheet)
    dropPhoto = false, // edit sheet: remove the note's photo on save
    fullPhotoUrl = null;
  // Photo records: { id, type, width, height, size, at, draft, bytes, thumb }.
  const memPhotos = new Map(); // records picked in this window (native drafts live only here)
  const thumbUrls = new Map();
  let recog = null, // board recognition for the current draft photo
    photoBusy = false;
  const demo = {
    id: "felt-example",
    name: "蓝帽子（示例）",
    appearance: "蓝色棒球帽，通常坐在靠走道的一侧。",
    tags: ["calls-wide"],
    exploit:
      "小注时他愿意拿第三对跟到底。下次类似单挑底池，我想用好顶对下一次小价值注，同时记录他面对大注的反应。",
    notes: [
      {
        id: "demo-hand",
        at: "2026-01-01T20:00:00Z",
        street: "河牌",
        text: "单挑底池，河牌我下约三分之一池，他用第三对跟注并亮牌。",
        reflection:
          "这次只看到了他面对小注的反应。下次把下注前底池和实际金额一起记下。",
        heroCards: ["As", "Qs"],
        villainCards: ["8h", "7h"],
        board: ["Ac", "Jd", "8s", "3c", "2h"],
      },
    ],
    createdAt: "2026-01-01T20:00:00Z",
    updatedAt: "2026-01-01T20:00:00Z",
  };
  const playerBy = (id) =>
    id === demo.id ? demo : book.players.find((p) => p.id === id);
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => t.classList.remove("on"), 3500);
  }
  const noteArrays = (n) => Object.keys(groups).map((k) => n[k] || []);
  function checkBook(raw) {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    const str = (v, max) => typeof v === "string" && v.length <= max;
    const date = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
    const check = (v, msg) => {
      if (!v) throw Error(msg);
    };
    const identifiers = new Set();
    check(
      obj?.format === "felt-notes" &&
        obj.version === 1 &&
        Array.isArray(obj.players),
      "请选择牌桌手记导出的 JSON 完整备份。",
    );
    for (const p of obj.players) {
      check(
        p &&
          str(p.id, 150) &&
          p.id &&
          p.id !== demo.id &&
          !identifiers.has(p.id) &&
          str(p.name, 80) &&
          p.name.trim() &&
          str(p.appearance ?? "", 5000) &&
          str(p.exploit ?? "", 30000) &&
          Array.isArray(p.tags) &&
          p.tags.every((t) => str(t, 60)) &&
          date(p.createdAt) &&
          date(p.updatedAt) &&
          Array.isArray(p.notes),
        "备份中有一份牌手档案格式不完整。",
      );
      identifiers.add(p.id);
      if (p.fieldTimes != null)
        check(
          typeof p.fieldTimes === "object" &&
            Object.values(p.fieldTimes).every(date),
          "备份中的档案编辑时间无效。",
        );
      const ids = new Set();
      for (const n of p.notes) {
        check(
          n &&
            str(n.id, 150) &&
            n.id &&
            !ids.has(n.id) &&
            str(n.text ?? "", 30000) &&
            str(n.reflection ?? "", 30000) &&
            str(n.street ?? "", 40) &&
            date(n.at) &&
            (!n.updatedAt || date(n.updatedAt)) &&
            (!n.assignedAt || date(n.assignedAt)) &&
            (!n.originPlayer || str(n.originPlayer, 150)),
          "备份中有一条记录格式不完整。",
        );
        if (n.photo != null)
          check(photoMetaOk(n.photo), "备份中有一条记录的照片信息无效。");
        ids.add(n.id);
        const all = [];
        for (const k of Object.keys(groups)) {
          const cards = n[k] ?? [];
          check(
            Array.isArray(cards) &&
              cards.length <= groups[k][1] &&
              cards.every(
                (c) => typeof c === "string" && /^[2-9TJQKA][shdc]$/.test(c),
              ),
            "备份中有一张牌的格式不正确。",
          );
          all.push(...cards);
        }
        check(new Set(all).size === all.length, "备份中的一手牌有重复牌。");
      }
    }
    // Inline photos only exist in the native shell's book and in backups.
    if (obj.photos != null) {
      check(
        typeof obj.photos === "object" && !Array.isArray(obj.photos) &&
          Object.entries(obj.photos).every(([id, p]) => photoIdPattern.test(id) && inlineShapeOk(p)),
        "备份中的照片区格式无效。",
      );
    }
    return obj;
  }
  const whole = (v, max) => Number.isInteger(v) && v >= 1 && v <= max;
  function photoMetaOk(m) {
    return !!m && typeof m === "object" && typeof m.id === "string" &&
      photoIdPattern.test(m.id) && m.type === "image/jpeg" &&
      whole(m.width, 4096) && whole(m.height, 4096) && whole(m.size, PHOTO.maxBytes);
  }
  // Cheap shape check; full byte and decode checks run when a backup is imported.
  function inlineShapeOk(p) {
    return !!p && typeof p === "object" && p.type === "image/jpeg" &&
      whole(p.width, 4096) && whole(p.height, 4096) && typeof p.data === "string" &&
      p.data.length <= Math.ceil((PHOTO.maxBytes * 4) / 3) + 4 && p.data.startsWith("/9j/");
  }
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("felt-notes-journal", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("journal");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function storageError(e) {
    if (e?.name === "QuotaExceededError" || /quota|space|空间/i.test(e?.message || ""))
      return Error("手机存储空间不足，这次没有保存。草稿还在；可以先保存完整备份、清理空间后再试。");
    return e || Error("本机存档无法写入，请检查可用空间。");
  }
  // Photos share the "journal" store under "photo:<id>" keys, so the database
  // version stays at 1 and an older cached copy of the app can still open it.
  function readDb(mutate, photoOps) {
    return new Promise((resolve, reject) => {
      const tr = database.transaction(
          "journal",
          mutate ? "readwrite" : "readonly",
        ),
        store = tr.objectStore("journal"),
        req = store.get("book");
      let value, failure;
      req.onsuccess = () => {
        try {
          value = req.result ? checkBook(req.result) : emptyBook();
          if (mutate) {
            mutate(value);
            checkBook(value);
            store.put(value, "book");
            for (const rec of photoOps?.save || [])
              store.put({ ...rec, draft: false }, photoKey(rec.id));
          }
        } catch (e) {
          failure = e;
          tr.abort();
        }
      };
      tr.oncomplete = () => resolve(value);
      tr.onerror = tr.onabort = () =>
        reject(failure || storageError(tr.error));
    });
  }
  // Runs `fn` against the book; `ops.save` lists photo records the result uses.
  async function change(fn, ops = null) {
    if (!ready) throw Error("存档尚未打开。");
    if (native) {
      const next = nativeQueue.then(async () => {
        const data = JSON.parse(JSON.stringify(book));
        fn(data);
        if (ops?.save?.length) {
          data.photos = data.photos || {};
          for (const rec of ops.save) data.photos[rec.id] = toInline(rec);
        }
        pruneInline(data);
        checkBook(data);
        try {
          await native.save(JSON.stringify(data));
        } catch (e) {
          throw storageError(e);
        }
        book = data;
      });
      nativeQueue = next.catch(() => {});
      return next;
    }
    book = await readDb(fn, ops);
  }
  function photoIdsIn(data) {
    const ids = new Set();
    for (const p of data.players) for (const n of p.notes) if (n.photo?.id) ids.add(n.photo.id);
    return ids;
  }
  function pruneInline(data) {
    if (!data.photos) return;
    const used = photoIdsIn(data);
    for (const id of Object.keys(data.photos)) if (!used.has(id)) delete data.photos[id];
    if (!Object.keys(data.photos).length) delete data.photos;
  }
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const tr = database.transaction("journal", mode);
      const out = fn(tr.objectStore("journal"));
      tr.oncomplete = () => resolve(out);
      tr.onerror = tr.onabort = () => reject(storageError(tr.error));
    });
  }
  // Deletes stored photos that no note and no saved draft points to. A draft
  // photo from another window gets a day before it counts as abandoned.
  async function sweepPhotos() {
    if (native || !database) return;
    const keep = new Set(availableDrafts().map((d) => d.value.photo?.id).filter(Boolean));
    if (draft.photo) keep.add(draft.photo.id);
    await idb("readwrite", (store) => {
      const req = store.get("book");
      req.onsuccess = () => {
        for (const id of req.result ? photoIdsIn(req.result) : []) keep.add(id);
        const keys = store.getAllKeys(IDBKeyRange.bound("photo:", "photo:￿"));
        keys.onsuccess = () => {
          for (const key of keys.result) {
            if (keep.has(String(key).slice(6))) continue;
            const got = store.get(key);
            got.onsuccess = () => {
              const rec = got.result;
              if (!rec?.draft || !(Date.now() - Date.parse(rec.at) < 864e5)) store.delete(key);
            };
          }
        };
      };
    });
  }
  const sweepLater = () => setTimeout(() => sweepPhotos().catch(() => {}), 500);

  /* ---------- photo bytes ---------- */

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(text) {
    const s = atob(text);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }
  const toInline = (r) => ({ type: "image/jpeg", width: r.width, height: r.height, data: toBase64(r.bytes) });
  function fromInline(id, p) {
    const bytes = fromBase64(p.data);
    return { id, type: "image/jpeg", width: p.width, height: p.height, size: bytes.byteLength, bytes, thumb: null };
  }
  const blobOf = (rec, thumb) => new Blob([thumb && rec.thumb ? rec.thumb : rec.bytes], { type: "image/jpeg" });
  async function loadPhotos(ids) {
    const out = new Map(), rest = [];
    for (const id of ids) memPhotos.has(id) ? out.set(id, memPhotos.get(id)) : rest.push(id);
    if (!rest.length) return out;
    if (native) {
      for (const id of rest) if (book.photos?.[id]) out.set(id, fromInline(id, book.photos[id]));
      return out;
    }
    await idb("readonly", (store) => {
      for (const id of rest) {
        const req = store.get(photoKey(id));
        req.onsuccess = () => req.result && out.set(id, req.result);
      }
    });
    return out;
  }
  // File signatures we are willing to decode: JPEG, PNG, WebP, HEIC/HEIF.
  function sniffImage(head) {
    const b = new Uint8Array(head), text = (a, z) => String.fromCharCode(...b.subarray(a, z));
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b[0] === 0x89 && text(1, 4) === "PNG") return "png";
    if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
    if (text(4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(text(8, 12))) return "heic";
    return "";
  }
  function decodeImage(blob) {
    // <img> honours camera orientation everywhere; createImageBitmap is the fallback.
    const viaImage = new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(Error("decode")); };
      img.src = url;
    });
    const fallback = () => window.createImageBitmap
      ? createImageBitmap(blob, { imageOrientation: "from-image" })
      : Promise.reject(Error("decode"));
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => fallback().then(resolve, reject), 8000);
    });
    return Promise.race([viaImage, late])
      .catch(fallback)
      .catch(() => { throw Error("无法读取这张照片，请换一张试试。"); })
      .finally(() => clearTimeout(timer));
  }
  const sizeOf = (img) => [img.naturalWidth || img.width, img.naturalHeight || img.height];
  function scaled(img, side) {
    const [w, h] = sizeOf(img), s = Math.min(1, side / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const x = c.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const jpeg = (canvas, quality) => new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b && b.type === "image/jpeg" ? resolve(b) : reject(Error("照片压缩失败，请再试一次。"))), "image/jpeg", quality));
  // Re-encoding drops EXIF (including GPS) and anything hidden in the file.
  // Walks the JPEG header up to the scan. "clean" means: baseline or progressive,
  // no metadata besides the plain JFIF header, so the bytes are safe to keep as-is.
  function jpegScan(b) {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    const keep = [];
    let i = 2, clean = true, frame = null;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      while (b[i + 1] === 0xff && i + 2 < b.length) i++; // fill bytes
      const m = b[i + 1];
      if (m === 0xd8 || m === 0xd9 || m === 0x00) return null;
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2 || i + 2 + len > b.length) return null;
      const end = i + 2 + len;
      if (m === 0xda) return frame ? { clean: clean && frame.plain, keep, scan: i, frame } : null;
      let meta = false;
      if (m === 0xe0) meta = String.fromCharCode(...b.subarray(i + 4, i + 9)) !== "JFIF\0";
      else if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) meta = true;
      else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (frame || len < 8) return null;
        frame = {
          plain: m === 0xc0 || m === 0xc2,
          height: (b[i + 5] << 8) | b[i + 6],
          width: (b[i + 7] << 8) | b[i + 8],
        };
      }
      if (meta) clean = false;
      else keep.push([i, end]);
      i = end;
    }
    return null;
  }
  // Drops metadata segments from a JPEG this app just encoded (some browsers add them).
  function stripJpeg(buffer) {
    const b = new Uint8Array(buffer), info = jpegScan(b);
    if (!info) throw Error("照片压缩失败，请再试一次。");
    if (info.clean) return buffer;
    const parts = [b.subarray(0, 2), ...info.keep.map(([a, z]) => b.subarray(a, z)), b.subarray(info.scan)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out.buffer;
  }
  async function encodePhoto(img) {
    const canvas = scaled(img, PHOTO.side);
    let quality = PHOTO.quality, blob = await jpeg(canvas, quality);
    while (blob.size > PHOTO.maxBytes * 0.5 && quality > 0.5) {
      quality -= 0.1;
      blob = await jpeg(canvas, quality);
    }
    const bytes = stripJpeg(await blob.arrayBuffer());
    if (bytes.byteLength > PHOTO.maxBytes) throw Error("照片压缩后仍太大，请换一张。");
    const thumb = await jpeg(scaled(canvas, PHOTO.thumb), 0.72);
    return {
      canvas,
      record: {
        id: uid(), type: "image/jpeg", width: canvas.width, height: canvas.height,
        size: bytes.byteLength, at: now(), draft: true,
        bytes, thumb: await thumb.arrayBuffer(),
      },
    };
  }
  async function compressPhoto(file) {
    if (!file?.size) throw Error("没有读到照片。");
    if (/svg|xml|html/i.test(file.type)) throw Error("只能添加照片（JPEG、HEIC、PNG 或 WebP）。");
    if (file.size > PHOTO.maxInput) throw Error("这张照片超过 40 MB，请换一张。");
    if (!sniffImage(await file.slice(0, 16).arrayBuffer()))
      throw Error("只能添加照片（JPEG、HEIC、PNG 或 WebP）。");
    const img = await decodeImage(file);
    const [w, h] = sizeOf(img);
    if (!w || !h || w * h > PHOTO.maxPixels) throw Error("无法读取这张照片，请换一张试试。");
    try {
      return await encodePhoto(img);
    } finally {
      img.close?.();
    }
  }
  // A backup photo must be a complete JPEG that decodes to the stated size.
  async function verifyInline(id, p) {
    if (!photoIdPattern.test(id) || !inlineShapeOk(p) || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data))
      throw Error("shape");
    const bytes = new Uint8Array(fromBase64(p.data));
    const n = bytes.length;
    if (n > PHOTO.maxBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
        bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) throw Error("bytes");
    const info = jpegScan(bytes);
    if (!info || info.frame.width !== p.width || info.frame.height !== p.height) throw Error("header");
    const img = await decodeImage(new Blob([bytes], { type: "image/jpeg" }));
    try {
      const [w, h] = sizeOf(img);
      if (w !== p.width || h !== p.height) throw Error("size");
      // A clean JPEG (what this app writes) is restored byte for byte. Anything
      // with extra metadata, an unusual coding mode or an oversize frame is
      // re-encoded once; the result is clean, so later round trips are exact.
      if (info.clean && w <= PHOTO.side && h <= PHOTO.side) {
        const thumb = await jpeg(scaled(img, PHOTO.thumb), 0.72);
        return {
          id, type: "image/jpeg", width: w, height: h, size: n, at: now(), draft: false,
          bytes: bytes.buffer, thumb: await thumb.arrayBuffer(), restored: "exact",
        };
      }
      const { record } = await encodePhoto(img);
      return { ...record, id, draft: false, restored: "normalised" };
    } finally {
      img.close?.();
    }
  }
  // Note references must describe the bytes actually stored.
  function syncPhotoMeta(data, photos) {
    for (const p of data.players) for (const n of p.notes) {
      const rec = n.photo && photos.get(n.photo.id);
      if (rec) n.photo = { id: rec.id, type: rec.type, width: rec.width, height: rec.height, size: rec.size };
    }
  }
  async function storageNote(extra) {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota && est.quota - est.usage < Math.max(extra * 20, 30 * 1024 * 1024))
        toast("本机可用存储不多，照片可能存不下。建议先保存完整备份。");
    } catch { /* estimates are optional */ }
  }
  const chronology = () =>
    book.players
      .flatMap((p) => p.notes.map((n) => ({ p, n })))
      .sort((a, b) => Date.parse(b.n.at) - Date.parse(a.n.at));
  function avatar(p) {
    const value = Array.from(p.name.trim())[0] || "♠";
    let hash = 0;
    for (const c of p.name) hash += c.codePointAt(0);
    return `<span class="avatar t${hash % 4}" aria-hidden="true">${esc(value)}</span>`;
  }
  function chips(ts) {
    return `<div class="chips">${ts.map((t) => `<span class="pill">${esc(label(t))}</span>`).join("")}</div>`;
  }
  function paintNav() {
    const page = selState.page === "profile" ? "players" : selState.page;
    const html = navs
      .map(
        ([v, k, s]) =>
          `<button class="${page === v ? "active" : ""}" ${page === v ? 'aria-current="page"' : ""} data-action="nav" data-id="${v}">${icon(k)}<span>${s}</span></button>`,
      )
      .join("");
    $("#sidebar-nav").innerHTML = html;
    $("#mobile-nav").innerHTML = html;
    $("#crumb").textContent =
      selState.page === "profile"
        ? "牌手详情"
        : navs.find((x) => x[0] === page)[2];
  }
  function move(page, id = null) {
    selState.page = page;
    selState.id = id;
    selState.tab = "history";
    render();
    window.scrollTo(0, 0);
  }
  function head(title, meta, act = "") {
    return `<div class="page-head"><div><h1>${esc(title)}</h1>${meta ? `<p class="subline">${meta}</p>` : ""}</div>${act}</div>`;
  }
  function missing(k, title, msg, action = "") {
    return `<div class="empty"><span class="em-icon">${icon(k)}</span><strong>${esc(title)}</strong><p>${esc(msg)}</p>${action}</div>`;
  }
  function playerRow(p) {
    return `<button class="playerrow" data-action="profile" data-id="${esc(p.id)}">${avatar(p)}<span class="rmain"><span class="rname">${esc(p.name)}</span><span class="rowmeta" style="display:block">${esc(p.appearance || "尚未填写辨认特征")}</span>${p.tags.length ? chips(p.tags.slice(0, 4)) : ""}</span><span class="rowmeta nowrap">${p.notes.length} 条</span><span class="chev">${icon("chev")}</span></button>`;
  }
  function fillList() {
    const q = selState.query.toLocaleLowerCase().trim(),
      f = selState.filter;
    const list = roster()
      .filter(
        (p) =>
          (!f || p.tags.includes(f)) &&
          (!q ||
            [p.name, p.appearance, ...p.tags.map(label)]
              .join(" ")
              .toLocaleLowerCase()
              .includes(q)),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    $("#roster").innerHTML = list.length
      ? list.map(playerRow).join("")
      : roster().length
        ? missing(
            "search",
            "没有匹配的牌手",
            "试试昵称、穿着，或者换一个标签。",
            button("清除筛选", "reset-filter", "", "soft"),
          )
        : missing(
            "users",
            "记下你的第一位牌手",
            "给他取个好认的昵称，就能把以后的笔记记在一起。",
            button("建立牌手档案", "add-player", "plus", "soft"),
          );
  }
  function cardHTML(c) {
    const rank = c[0] === "T" ? "10" : c[0];
    return `<span class="playing ${"hd".includes(c[1]) ? "red" : ""}" aria-label="${suitNames[c[1]]}${rank}">${rank}<b>${suits[c[1]]}</b></span>`;
  }
  function cardsBlock(n) {
    return Object.entries(groups)
      .filter(([k]) => n[k]?.length)
      .map(
        ([k, [name]]) =>
          `<div class="cardline"><span>${name}</span><div class="cards">${n[k].map(cardHTML).join("")}</div></div>`,
      )
      .join("");
  }
  function entry(p, n, { detail = false, link = true, short = false } = {}) {
    const inbox = p.id === inboxId;
    const place = !inbox && link
      ? `<button class="text-btn" data-action="profile" data-id="${esc(p.id)}">${esc(p.name)}</button>`
      : "";
    const controls = detail && p !== demo
      ? `<div class="note-controls"><button class="linkbtn" data-action="assign" data-player="${esc(p.id)}" data-id="${esc(n.id)}">${inbox ? "关联牌手" : "更改关联"}</button><button class="iconbtn" data-action="edit-note" data-player="${esc(p.id)}" data-id="${esc(n.id)}" aria-label="编辑本条记录">${icon("edit")}</button></div>`
      : "";
    return `<article class="entry"><div class="entry-meta"><time>${p === demo ? "示例" : esc(fmt(n.at))}</time>${place}${n.street && n.street !== "综合" ? `<span class="street">${esc(n.street)}</span>` : ""}</div>${n.photo ? photoThumb(n.photo, "entry-photo") : ""}${n.text ? `<p>${esc(short ? n.text.slice(0, 105) + (n.text.length > 105 ? "…" : "") : n.text)}</p>` : ""}${!short ? cardsBlock(n) : !n.text ? `<div class="cards">${noteArrays(n).flat().map(cardHTML).join("")}</div>` : ""}${!short && n.reflection ? `<p class="reflection"><strong>我的复盘</strong> ${esc(n.reflection)}</p>` : ""}${controls}</article>`;
  }
  function home() {
    const players = roster();
    const ts = [...new Set(players.flatMap((p) => p.tags))];
    root.innerHTML =
      head("牌手档案", `${players.length} 位牌手`, button("新建牌手", "add-player", "plus", "solid")) +
      `<section class="panel"><div class="tools"><label class="search">${icon("search")}<input id="search" aria-label="搜昵称、特征或标签" placeholder="搜昵称、特征或标签" value="${esc(selState.query)}"></label><select aria-label="按标签筛选" id="filter" class="filter"><option value="">全部标签</option>${ts.map((t) => `<option value="${esc(t)}" ${selState.filter === t ? "selected" : ""}>${esc(label(t))}</option>`).join("")}</select></div><div id="roster" class="players"></div></section>`;
    fillList();
  }
  function profile() {
    const p = playerBy(selState.id);
    if (!p) {
      move("players");
      return;
    }
    const isDemo = p === demo,
      history = selState.tab === "history";
    root.innerHTML = `<button class="linkbtn topback" data-action="nav" data-id="players">${icon("back")} 牌手档案</button><div class="page-head profile-head"><div class="profile-lead">${avatar(p)}<div class="profile-header-text"><h1>${esc(p.name)}</h1><div class="subline">${isDemo ? "虚构示例档案" : `${p.notes.length} 条记录 · 建于 ${esc(shortDate(p.createdAt))}`}</div></div></div>${isDemo ? "" : button("编辑档案", "edit-player", "edit", "outline", p.id)}</div>
 <div class="profilegrid"><section class="stack"><div class="tabs" aria-label="牌手笔记类型">${[
   ["history", "手牌与观察"],
   ["exploit", "长期剥削笔记"],
 ]
   .map(
     ([key, txt]) =>
       `<button class="tab ${selState.tab === key ? "selected" : ""}" aria-pressed="${selState.tab === key}" data-action="profile-tab" data-id="${key}">${txt}</button>`,
   )
   .join("")}</div>
 ${
   history
     ? `<div class="panel"><div class="section-head"><h2>手牌与观察</h2>${isDemo ? "" : button("记一条", "add-note", "plus", "solid", p.id)}</div>${
         p.notes.length
           ? [...p.notes]
               .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
               .map((n) => entry(p, n, { detail: true, link: false }))
               .join("")
           : missing(
               "cards",
               "从第一条观察开始",
               "可以只记一句话，有亮牌时再补上花色。",
             )
       }</div>`
     : `<div class="panel"><div class="section-head"><h2>长期剥削笔记</h2>${isDemo ? "" : button("编辑打法", "exploit", "edit", "soft", p.id)}</div>${p.exploit ? `<div class="readtext">${esc(p.exploit)}</div>` : `<p class="muted">记下你打算怎么调整、适用的牌面，以及什么新证据会让你改主意。</p>`}</div>`
 }</section>
 <aside class="stack"><section class="panel"><div class="section-head"><h2>辨认特征</h2>${icon("users")}</div><div class="readtext">${esc(p.appearance || "尚未填写")}</div><hr class="sep"><strong class="small">打法标签</strong>${p.tags.length ? chips(p.tags) : '<p class="quiet">尚未打标签</p>'}</section>${isDemo ? '<section class="panel sample-panel"><strong>示例只供阅读</strong><p>这里的牌手和手牌均为虚构，不计入你的存档和导出。</p></section>' : `<section class="panel sample-panel"><h2>单人复盘</h2><p>预览这位牌手的手牌、长期笔记和给 AI 的分析问题。</p>${button("预览复盘材料", "single-report", "book", "outline", p.id)}</section>`}</aside></div>`;
  }
  function timelineList() {
    const q = selState.noteQuery.toLocaleLowerCase().trim();
    const list = chronology().filter(({ p, n }) =>
      [
        p.name,
        n.street,
        n.text,
        n.reflection,
        n.photo ? "照片" : "",
        ...noteArrays(n)
          .flat()
          .map((c) => (c[0] === "T" ? "10" : c[0]) + suits[c[1]]),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(q),
    );
    if (list.length) return list.map(({ p, n }) => entry(p, n, { detail: true })).join("");
    return q ? '<p class="quiet">没有匹配的笔记</p>' : '<p class="quiet">还没有笔记</p>';
  }

  // Each draft has its own key. A second window editing a stale copy forks its
  // draft instead of overwriting the newer text. Only a committed copy is cleared.
  const draftPrefix = "felt-notes:compose:";
  // A draft may also carry a photo reference and a confirmed board. The photo
  // bytes live in IndexedDB; only the small reference goes to localStorage.
  const newDraft = () => ({ id: uid(), text: "", target: "", at: now(), photo: null, board: [] });
  let draft = newDraft(), storedDraft = null, draftWarning = "";
  // draftSlot changes whenever the composer starts holding a different draft
  // (or the same draft is pointed at another player); photoSeq orders picks.
  // A photo finishing late is attached only if both still match its start.
  let draftSlot = 0, photoSeq = 0;
  function replaceDraft(next, raw = null) {
    draft = next;
    storedDraft = raw;
    recog = null;
    draftSlot++;
  }
  // While a photo is being processed these would change which draft it belongs to.
  const blockedWhileBusy = new Set([
    "add-note", "resume-draft", "detach-draft", "remove-photo",
    "board-scan", "board-accept", "board-edit", "board-dismiss",
  ]);
  const hasDraft = (d) => !!(d.text || d.photo);
  function cleanBoard(list) {
    if (!Array.isArray(list) || list.length > 5) return [];
    const cards = list.filter((c) => typeof c === "string" && cardPattern.test(c));
    return cards.length === list.length && new Set(cards).size === cards.length ? cards : [];
  }
  function availableDrafts() {
    const found = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(draftPrefix)) continue;
        const raw = localStorage.getItem(key);
        let value;
        try { value = JSON.parse(raw); } catch { continue; }
        if (!value || typeof value !== "object") continue;
        value.photo = photoMetaOk(value.photo) ? value.photo : null;
        value.board = value.photo ? cleanBoard(value.board) : [];
        if (key === draftPrefix + value.id && typeof value.text === "string" &&
            hasDraft(value) && value.text.length <= 30000 && Number.isFinite(Date.parse(value.at))) {
          found.push({ value, raw });
        }
      }
    } catch { draftWarning = "草稿仅在当前窗口，请及时保存笔记"; }
    return found.sort((a, b) => Date.parse(b.value.changed || b.value.at) - Date.parse(a.value.changed || a.value.at));
  }
  function loadDraft(item) {
    replaceDraft(item.value, item.raw);
  }
  function writeDraft(text) {
    if (!hasDraft(draft) && text) draft.at = now();
    draft.text = text;
    persistDraft();
  }
  function persistDraft() {
    try {
      let key = draftPrefix + draft.id;
      if (localStorage.getItem(key) !== storedDraft) {
        draft = { ...draft, id: uid() };
        key = draftPrefix + draft.id;
      }
      draft.changed = now();
      const next = hasDraft(draft) ? JSON.stringify(draft) : null;
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
      storedDraft = next;
      draftWarning = "";
    } catch { draftWarning = "草稿仅在当前窗口，请及时保存笔记"; }
  }
  function syncComposer() {
    const status = $("#draft-status"), save = $("#quick-save");
    if (status) status.textContent = draftWarning ||
      (photoBusy ? "正在处理照片…" : hasDraft(draft) ? "草稿已保存" : "");
    if (save) save.disabled = photoBusy || !(draft.text.trim() || draft.photo);
    const picker = $("#photo-file");
    if (picker) {
      picker.disabled = photoBusy;
      picker.closest(".photo-btn")?.setAttribute("aria-busy", String(photoBusy));
    }
    for (const b of document.querySelectorAll("#main [data-action]"))
      if (blockedWhileBusy.has(b.dataset.action)) {
        if (photoBusy) b.setAttribute("aria-disabled", "true");
        else b.removeAttribute("aria-disabled");
      }
  }

  /* ---------- photo in the composer ---------- */

  function photoThumb(meta, cls = "") {
    return `<button type="button" class="photo-thumb ${cls}" data-action="view-photo" data-id="${esc(meta.id)}" aria-label="查看照片"><img data-photo="${esc(meta.id)}" alt=""><span class="photo-missing">照片不在本机</span></button>`;
  }
  const act = (txt, action, cls = "") =>
    `<button type="button" class="photo-act ${cls}" data-action="${action}">${txt}</button>`;
  function boardLine() {
    if (draft.board.length)
      return `<span class="board-label">公共牌</span><span class="cards">${draft.board.map(cardHTML).join("")}</span>${act("修改", "board-edit")}`;
    const r = recog?.id === draft.photo.id ? recog : null;
    if (!r || r.state === "idle")
      return `${act("识别公共牌", "board-scan")}${act("手动选牌", "board-edit")}`;
    if (r.state === "running") return `<span class="board-label" role="status">正在识别公共牌…</span>`;
    if (r.state === "done") {
      const chips = r.cards.map((c) => c.code && c.sure ? cardHTML(c.code)
        : c.code ? cardHTML(c.code).replace('class="playing', 'class="playing unsure') : '<span class="playing guess" aria-label="未认出">?</span>').join("");
      return r.sure
        ? `<span class="board-label">识别结果，请核对</span><span class="cards">${chips}</span>${act("确认", "board-accept", "strong")}${act("修改", "board-edit")}${act("忽略", "board-dismiss")}`
        : `<span class="board-label">没把握，请手动核对</span><span class="cards">${chips}</span>${act("手动选牌", "board-edit", "strong")}${act("只留照片", "board-dismiss")}`;
    }
    if (r.state === "dismissed") return act("选公共牌", "board-edit");
    return `<span class="board-label">${r.state === "error" ? "识别没成功" : "没认出一排公共牌"}</span>${act("手动选牌", "board-edit")}`;
  }
  function photoPanel() {
    return `${photoThumb(draft.photo)}<div class="photo-side"><div class="board-line">${boardLine()}</div>${act("移除照片", "remove-photo", "muted-act")}</div>`;
  }
  function paintPhoto() {
    const el = $("#compose-photo");
    if (!el) return;
    el.hidden = !draft.photo;
    el.innerHTML = draft.photo ? photoPanel() : "";
    hydratePhotos(el);
    syncComposer();
  }
  async function hydratePhotos(scope) {
    const imgs = [...scope.querySelectorAll("img[data-photo]")].filter((i) => !i.getAttribute("src"));
    if (!imgs.length) return;
    const ids = [...new Set(imgs.map((i) => i.dataset.photo))].filter((id) => !thumbUrls.has(id));
    let found = new Map();
    try { found = await loadPhotos(ids); } catch { /* shown as missing */ }
    for (const [id, rec] of found) thumbUrls.set(id, URL.createObjectURL(blobOf(rec, true)));
    for (const img of imgs) {
      const url = thumbUrls.get(img.dataset.photo);
      if (url) img.src = url;
      else img.parentElement.classList.add("missing");
    }
  }
  async function addPhoto(file) {
    if (photoBusy) throw Error("上一张照片还在处理，请稍等。");
    const slot = draftSlot, seq = ++photoSeq, owner = draft.target;
    photoBusy = true;
    syncComposer();
    let made;
    try {
      made = await compressPhoto(file);
      const { record } = made;
      storageNote(record.size);
      if (!native) await idb("readwrite", (store) => { store.put(record, photoKey(record.id)); });
      memPhotos.set(record.id, record);
    } finally {
      photoBusy = false;
      syncComposer();
    }
    const { record, canvas } = made;
    if (slot !== draftSlot || seq !== photoSeq || owner !== draft.target) {
      // The composer moved on while this photo was processed: never attach it elsewhere.
      memPhotos.delete(record.id);
      if (!native) idb("readwrite", (store) => { store.delete(photoKey(record.id)); }).catch(() => {});
      toast("照片处理期间草稿已切换，这张照片没有附加。");
      return;
    }
    if (!hasDraft(draft)) draft.at = now();
    draft.photo = { id: record.id, type: record.type, width: record.width, height: record.height, size: record.size };
    draft.board = [];
    persistDraft();
    if (native) draftWarning = "照片在保存笔记后才会存档";
    recognise(record.id, canvas);
    sweepLater();
    requestStandaloneStorage();
  }
  // Recognition never blocks saving: it starts after the preview is shown.
  function recognise(id, source) {
    if (!vision) {
      recog = { id, state: "idle" };
      paintPhoto();
      return;
    }
    recog = { id, state: "running" };
    paintPhoto();
    setTimeout(() => {
      let result = null;
      try { result = vision.detect(source); } catch { /* reported below */ }
      if (draft.photo?.id !== id) return;
      if (!result) recog = { id, state: "error" };
      else if (!result.found) recog = { id, state: "none" };
      else recog = { id, state: "done", sure: result.sure, cards: result.cards };
      paintPhoto();
    }, 80);
  }
  async function scanStored() {
    const id = draft.photo?.id;
    const rec = id && (await loadPhotos([id])).get(id);
    if (!rec) throw Error("照片已不在本机，请移除后重新添加。");
    recog = { id, state: "running" };
    paintPhoto();
    const img = await decodeImage(blobOf(rec, false));
    recognise(id, img);
  }
  async function fillFull(img, id) {
    const rec = (await loadPhotos([id])).get(id);
    if (!rec) throw Error("这张照片不在本机（可能来自不含照片的备份）。");
    if (fullPhotoUrl) URL.revokeObjectURL(fullPhotoUrl);
    fullPhotoUrl = URL.createObjectURL(blobOf(rec, false));
    img.width = rec.width;
    img.height = rec.height;
    img.src = fullPhotoUrl;
  }
  function boardForm() {
    const r = recog?.id === draft.photo?.id ? recog : null;
    const start = draft.board.length ? draft.board
      : r?.state === "done" ? r.cards.filter((c) => c.code && c.sure).map((c) => c.code) : [];
    draftCards = { heroCards: [], villainCards: [], board: [...new Set(start)] };
    cardPicker = null;
    editorGroups = ["board"];
    show("公共牌", `<form id="board-form">${draft.photo ? `<img class="photo-full board-ref" alt="牌局照片">` : ""}<p class="muted">对照照片核对点数和花色。看不清的牌可以空着。</p><div id="card-editor"></div>${formEnd("确认公共牌")}`);
    drawCards();
    const ref = modal.querySelector(".board-ref");
    if (ref) fillFull(ref, draft.photo.id).catch(() => ref.remove());
  }
  function timeline() {
    const target = playerBy(draft.target);
    // Assign values via the DOM so a leading newline in a draft survives reopening.
    const rest = availableDrafts().filter((d) => d.value.id !== draft.id);
    root.innerHTML = `<div class="notebook">${head("桌边笔记", "")}
      <form class="compose" id="quick-form">
        ${target ? `<div class="compose-for">记给 ${esc(target.name)} <button type="button" class="linkbtn" data-action="detach-draft">取消关联</button></div>` : ""}
        <textarea id="quick-text" aria-label="笔记正文" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="记一手牌，或写下刚看到的动作…" maxlength="30000" rows="4"></textarea>
        <div id="compose-photo" class="compose-photo" hidden></div>
        <div class="compose-footer"><label class="photo-btn" title="拍照或选照片">${icon("camera")}<span>照片</span><input type="file" id="photo-file" class="visually-hidden" accept="image/*" aria-label="拍照或选照片"></label><span class="quiet" id="draft-status"></span><button type="submit" id="quick-save" class="btn solid">保存笔记</button></div>
      </form>
      ${rest.length ? `<details class="other-drafts"><summary>其他草稿（${rest.length}）</summary>${rest.map(({value}) => button((value.photo ? "［照片］" : "") + value.text.slice(0, 40), "resume-draft", "edit", "outline", value.id)).join("")}</details>` : ""}
      <section class="journal"><div class="section-head"><h2>最近笔记</h2></div><label class="search">${icon("search")}<input aria-label="筛选笔记" id="note-search" placeholder="搜索笔记或牌手" value="${esc(selState.noteQuery)}"></label><div id="timeline-list">${timelineList()}</div></section></div>`;
    $("#quick-text").value = draft.text;
    paintPhoto();
  }
  function ensureInbox(data) {
    let inbox = data.players.find((p) => p.id === inboxId);
    if (!inbox) {
      inbox = { ...fresh("未关联牌手"), id: inboxId };
      data.players.push(inbox);
    }
    return inbox;
  }
  async function saveQuick() {
    const input = $("#quick-text");
    if (photoBusy) throw Error("照片还在处理，请稍等。");
    if (!input.value.trim() && !draft.photo) throw Error("先写一点内容，或加一张照片。");
    if (input.value !== draft.text) writeDraft(input.value);
    const snapshot = { ...draft, board: [...draft.board] }, written = storedDraft, stamp = now();
    let photo = null;
    if (snapshot.photo) {
      photo = (await loadPhotos([snapshot.photo.id])).get(snapshot.photo.id);
      if (!photo) throw Error("照片已不在本机，请移除后重新添加。文字草稿还在。");
    }
    input.readOnly = true;
    try {
      await change((data) => {
        const dest = snapshot.target ? requirePlayer(data, snapshot.target) : ensureInbox(data);
        const prior = data.players.flatMap((p) => p.notes).find((n) => n.id === snapshot.id);
        if (prior && prior.text === snapshot.text && (prior.photo?.id || "") === (snapshot.photo?.id || "")) return;
        const id = prior ? uid() : snapshot.id;
        const note = { id, at: snapshot.at, updatedAt: stamp, text: snapshot.text, street: "", reflection: "" };
        if (snapshot.board.length) note.board = snapshot.board;
        if (snapshot.photo) note.photo = { ...snapshot.photo };
        dest.notes.push(note);
        if (!dest.fieldTimes) dest.fieldTimes = Object.fromEntries(profileFields.map((k) => [k, fieldStamp(dest, k)]));
        dest.updatedAt = stamp;
      }, photo ? { save: [photo] } : null);
    } finally {
      input.readOnly = false;
    }
    if (photo) memPhotos.delete(photo.id);
    try {
      const key = draftPrefix + snapshot.id;
      if (localStorage.getItem(key) === written) localStorage.removeItem(key);
    } catch { /* The note was committed to the book. */ }
    if (draft.id === snapshot.id) {
      replaceDraft(newDraft());
      draftWarning = "";
    }
    selState.noteQuery = "";
    render();
    toast("笔记已保存");
    requestStandaloneStorage();
  }

  function requestStandaloneStorage() {
    if (storageRequested || native || location.protocol !== "https:" ||
        !navigator.storage?.persist ||
        !(navigator.standalone || window.matchMedia("(display-mode: standalone)").matches)) return;
    storageRequested = true;
    navigator.storage.persist().catch(() => {});
  }

  function exportPage() {
    const report = engine.report(book.players, selState.days);
    root.innerHTML =
      head("复盘导出", "按时间整理手牌，与 AI 一起回看自己的判断。") +
      `<div class="profilegrid exportgrid"><section class="panel"><div class="section-head"><h2>复盘材料</h2>${icon("book")}</div><div class="tabs">${[
        [7, "近 7 天"],
        [30, "近 30 天"],
        ["all", "全部"],
      ]
        .map(
          ([v, s]) =>
            `<button data-action="period" data-id="${v}" class="tab ${selState.days === v ? "selected" : ""}" aria-pressed="${selState.days === v}">${s}</button>`,
        )
        .join(
          "",
        )}</div><p class="muted">导出用代号替换牌手昵称，并省略辨认特征。笔记、长期打法和自定义标签会保留原文，交给 AI 前请先看一遍。</p>${roster().length ? `<details class="private-map"><summary>在本机对照牌手代号</summary>${roster().map((p, i) => `<div><b>P${String(i + 1).padStart(2, "0")}</b> ${esc(p.name)}</div>`).join("")}</details>` : ""}<pre class="readtext export-preview">${esc(report)}</pre><div class="actions">${button("导出 Markdown", "export-md", "download", "solid")}${button("复制全文", "copy-md", "copy")}</div></section><aside class="panel"><div class="section-head"><h2>完整备份</h2>${icon("download")}</div><p class="sidecopy">JSON 包含所有昵称、特征、花色、长期笔记和照片的压缩副本。换手机或清理数据前，先保存一份。</p><div class="stack">${button("保存完整备份", "backup", "download")}${photoIdsIn(book).size ? button("不含照片的备份", "backup-text", "", "outline") : ""}${button("从备份合并", "restore", "plus", "soft")}</div><input type="file" accept=".json,application/json" hidden id="restore-file"><p class="footnote">手机和电脑各自存档。可把 JSON 文件存到 iCloud 云盘，换手机时点「从备份合并」。</p>${native ? "" : `<p class="footnote" id="offline-status" role="status">${esc(offlineStatus)}</p>`}</aside></div>`;
  }
  function render() {
    paintNav();
    if (selState.page === "profile") profile();
    else if (selState.page === "notes") timeline();
    else if (selState.page === "export") exportPage();
    else home();
    hydratePhotos(root);
    syncComposer();
  }
  function show(title, body) {
    focusBefore = document.activeElement;
    modal.innerHTML = `<div class="modal-head"><h2 id="sheet-title">${esc(title)}</h2><button type="button" class="iconbtn" data-action="close" aria-label="关闭">${icon("x")}</button></div>${body}`;
    dialog.setAttribute("aria-labelledby", "sheet-title");
    if (!dialog.open) dialog.showModal();
  }
  function close() {
    dialog.close();
    modal.replaceChildren();
    pendingImport = null;
    cardPicker = null;
    editorGroups = null;
    dropPhoto = false;
    if (fullPhotoUrl) {
      URL.revokeObjectURL(fullPhotoUrl);
      fullPhotoUrl = null;
    }
    if (focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
  }
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  function formEnd(txt) {
    return `<div id="form-error" class="error-msg" role="alert"></div><div class="modal-actions">${button("取消", "close")}<button class="btn solid" type="submit">${txt}</button></div></form>`;
  }
  const field = (id, txt, hint = "") =>
    `<label class="field" for="${id}">${txt} ${hint ? `<small>${hint}</small>` : ""}</label>`;
  function profileForm(p) {
    newTags = new Set(
      p?.tags.filter((t) => engine.tags.some((x) => x.id === t)) || [],
    );
    show(
      p ? "编辑档案" : "新建牌手",
      `<form id="profile-form" data-id="${esc(p?.id || "")}">${field("pname", "昵称或代号")}<input id="pname" class="field-input" placeholder="例如：小明、大胖" maxlength="80" required value="${esc(p?.name || "")}">${field("appearance", "辨认特征", "选填")}<textarea id="appearance" class="field-input" rows="2" maxlength="5000" placeholder="衣着、习惯或常坐的位置">${esc(p?.appearance || "")}</textarea><div class="field">打法标签</div><div class="tag-options" id="tag-list"></div>${field("custom", "自定义标签", "多个用逗号分开")}<input class="field-input" id="custom" placeholder="例如：转牌小注后常弃牌" value="${esc(p?.tags.filter((t) => !engine.tags.some((x) => x.id === t)).join("，") || "")}">${field("longplay", "长期剥削笔记", "选填")}<textarea class="field-input" id="longplay" maxlength="30000" rows="3" placeholder="下次遇到他，我想怎么打？">${esc(p?.exploit || "")}</textarea>${formEnd("保存档案")}`,
      "profile",
    );
    drawTags();
  }
  function drawTags() {
    $("#tag-list").innerHTML = engine.tags
      .map(
        (t) =>
          `<button type="button" class="tag" data-action="tag" data-id="${t.id}" aria-pressed="${newTags.has(t.id)}">${esc(t.label)}</button>`,
      )
      .join("");
  }
  function exploitForm(p) {
    show(
      "长期剥削笔记",
      `<form id="exploit-form" data-id="${esc(p.id)}">${field("longplay", esc(p.name))}<textarea class="field-input" id="longplay" maxlength="30000" rows="8" placeholder="我观察到什么？下次我会如何调整？什么情况例外？">${esc(p.exploit || "")}</textarea>${formEnd("保存长期笔记")}`,
      "exploit",
    );
  }
  const localTime = (s) => {
    const d = new Date(s);
    return new Date(d - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  function noteForm(p, n) {
    draftCards = Object.fromEntries(
      Object.keys(groups).map((k) => [k, [...(n?.[k] || [])]]),
    );
    cardPicker = null;
    editorGroups = null;
    dropPhoto = false;
    const choices = n.street && !streets.includes(n.street) ? [...streets, n.street] : streets;
    show(
      "编辑笔记",
      `<form id="note-form" data-player="${esc(p.id)}" data-note="${esc(n.id)}" data-version="${esc(n.updatedAt || n.at)}" data-photo="${esc(n.photo?.id || "")}">${field("obs", "笔记正文")}<textarea class="field-input" id="obs" maxlength="30000" rows="6"></textarea>${n.photo ? `<div class="photo-edit" id="photo-edit">${photoThumb(n.photo)}<button type="button" class="linkbtn" data-action="toggle-photo" aria-pressed="false">移除照片</button></div>` : ""}<details class="hand-details"><summary>手牌详情与复盘</summary>${field("street", "街次")}<select class="field-input" id="street"><option value="">未标记</option>${choices.map((v) => `<option ${n.street === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select><div id="card-editor"></div>${field("reflect", "我的复盘", "选填")}<textarea class="field-input" id="reflect" maxlength="30000" rows="3"></textarea>${field("note-time", "记录时间")}<input id="note-time" class="field-input" type="datetime-local" value="${localTime(n.at)}" required></details>${formEnd("保存修改")}`,
    );
    $("#obs").value = n.text || "";
    $("#reflect").value = n.reflection || "";
    drawCards();
    hydratePhotos(modal);
  }
  function drawCards() {
    const el = $("#card-editor");
    let html = "";
    for (const [k, [name, max]] of Object.entries(groups)) {
      if (editorGroups && !editorGroups.includes(k)) continue;
      html += `<div class="card-field"><span>${name}</span><div class="cards">${draftCards[k].map((c, i) => `<button type="button" class="edit-card" data-action="pick-card" data-id="${k}/${i}" aria-label="修改${name} ${esc(c)}">${cardHTML(c)}</button>`).join("")}${draftCards[k].length < max ? `<button type="button" class="blank-card" data-action="pick-card" data-id="${k}/${draftCards[k].length}" aria-label="添加${name}">＋</button>` : ""}</div></div>`;
      if (cardPicker?.group === k) {
        const cur = draftCards[k][cardPicker.index],
          busy = new Set(Object.values(draftCards).flat());
        if (cur) busy.delete(cur);
        html += `<div class="card-picker"><div class="row-between"><strong class="small">${name} · 第 ${cardPicker.index + 1} 张</strong><button type="button" class="linkbtn" data-action="dismiss-picker">收起</button></div><div class="rank-grid">${ranks.map((r) => `<button type="button" data-action="rank" data-id="${r}" aria-pressed="${r === cardPicker.rank}">${r === "T" ? "10" : r}</button>`).join("")}</div><div class="suit-grid">${Object.entries(
          suits,
        )
          .map(
            ([s, v]) =>
              `<button type="button" data-action="suit" data-id="${s}" class="${"hd".includes(s) ? "red" : ""}" ${!cardPicker.rank || busy.has(cardPicker.rank + s) ? "disabled" : ""}>${v}<small>${suitNames[s]}</small></button>`,
          )
          .join(
            "",
          )}</div>${cur ? button("移除此牌", "remove-card", "", "delete") : ""}</div>`;
      }
    }
    el.innerHTML = html;
  }
  function assignForm(owner, id) {
    const p = playerBy(owner);
    if (!p?.notes.some((n) => n.id === id)) throw Error("找不到这条笔记，请重新打开。");
    show("关联牌手", `<form id="assign-form" data-player="${esc(owner)}" data-note="${esc(id)}">
      ${field("assign-name", "牌手昵称")}<input class="field-input" id="assign-name" maxlength="80" placeholder="已有或新的昵称" autocomplete="off">
      <div class="assign-options" id="assign-options"></div>${formEnd("关联牌手")}`);
    showAssignOptions();
    $("#assign-name").focus();
  }
  function showAssignOptions() {
    const field = $("#assign-name");
    const form = field.form, q = field.value.trim().toLocaleLowerCase();
    const matches = roster().filter((p) => p.name.toLocaleLowerCase().includes(q))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    $("#assign-options").innerHTML = matches.slice(0, 10).map((p) =>
      button(p.name + (p.appearance ? " · " + p.appearance.slice(0, 18) : ""), "assign-existing", "users", "soft", p.id)
    ).join("") + (form.dataset.player !== inboxId ? button("取消当前关联", "assign-existing", "", "outline", inboxId) : "");
  }
  async function assignNote(form, targetId = "") {
    const { player: owner, note: id } = form.dataset;
    const name = $("#assign-name").value.trim();
    if (!targetId && !name) throw Error("输入昵称，或点选已有牌手。");
    let result;
    await change((data) => {
      const source = requirePlayer(data, owner);
      const index = source.notes.findIndex((n) => n.id === id);
      if (index < 0) throw Error("这条笔记的归属已变化，请重新打开。");
      let target;
      if (targetId) target = targetId === inboxId ? ensureInbox(data) : requirePlayer(data, targetId);
      else {
        const matches = roster(data).filter((p) => p.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (matches.length > 1) throw Error("有重名牌手，请点列表中对应的那位。");
        target = matches[0];
        if (!target) { target = fresh(name); data.players.push(target); }
      }
      result = target.id === inboxId ? "已取消关联" : "已记到" + target.name + "的档案";
      if (source.id === target.id) return;
      if (target.notes.some((n) => n.id === id)) throw Error("目标档案已有同编号笔记，原记录仍在原处。");
      const n = source.notes.splice(index, 1)[0];
      const stamp = now();
      n.originPlayer = n.originPlayer || source.id;
      n.assignedAt = stamp;
      target.notes.push(n);
      for (const p of [source, target]) updateProfile(p, {});
    });
    close();
    render();
    toast(result);
  }
  function showSingle(p) {
    const report = engine.prompt(p);
    show(
      "单人复盘材料",
      `<p class="muted">已省略昵称和辨认特征。请检查笔记和标签原文。</p><pre class="readtext export-preview">${esc(report)}</pre><div class="actions">${button("复制给 AI", "copy-single", "copy", "solid", p.id)}${button("导出文件", "save-single", "download", "outline", p.id)}</div><p id="form-error" class="error-msg" role="alert"></p>`,
      "single",
    );
  }
  async function clip(text) {
    if (native) {
      await native.copy(text);
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    (dialog.open ? modal : document.body).append(area);
    area.value = text;
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw Error("浏览器没有剪贴板权限，请用导出文件。");
  }
  async function saveFile(filename, content, type) {
    if (native) {
      const done = await native.exportFile(filename, content);
      if (done === false) return;
      toast("文件导出已完成");
      return;
    }
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("已交给浏览器下载");
  }
  const todayFile = () => localTime(now()).slice(0, 10);
  function merge(existing, incoming) {
    const profiles = new Map();
    const entries = new Map();
    for (const p of [...existing.players, ...incoming.players]) {
      const prior = profiles.get(p.id);
      if (!prior) profiles.set(p.id, { ...p, notes: [] });
      else {
        const times = {};
        for (const key of profileFields) {
          const local = fieldStamp(prior, key), other = fieldStamp(p, key);
          const replace = Date.parse(other) > Date.parse(local);
          if (replace) prior[key] = p[key];
          times[key] = replace ? other : local;
        }
        prior.fieldTimes = times;
        if (Date.parse(p.updatedAt) > Date.parse(prior.updatedAt)) prior.updatedAt = p.updatedAt;
      }
      for (const n of p.notes) {
        // Old backups scoped note IDs to a player. Keep that scope across moves.
        const origin = n.originPlayer || p.id;
        const key = JSON.stringify([origin, n.id]);
        const current = entries.get(key);
        const moved = n.assignedAt ? Date.parse(n.assignedAt) : -Infinity;
        const edited = Date.parse(n.updatedAt || n.at);
        if (!current) entries.set(key, { origin, owner: p.id, moved, edited, body: n });
        else {
          if (moved > current.moved || (moved === current.moved && p.id < current.owner)) {
            current.owner = p.id;
            current.moved = moved;
          }
          if (edited > current.edited) { current.body = n; current.edited = edited; }
        }
      }
    }
    for (const { origin, owner, moved, body } of entries.values()) {
      const note = { ...body };
      if (Number.isFinite(moved)) {
        note.originPlayer = origin;
        note.assignedAt = new Date(moved).toISOString();
      }
      profiles.get(owner).notes.push(note);
    }
    existing.players = [...profiles.values()];
  }
  // Backups may carry photos as base64 JPEG. Each one is decoded and re-encoded
  // here before anything is written; a photo that fails is skipped, not trusted.
  async function openImport(raw) {
    let obj;
    try {
      obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      throw Error("请选择牌桌手记导出的 JSON 完整备份。");
    }
    if (!obj || typeof obj !== "object") throw Error("请选择牌桌手记导出的 JSON 完整备份。");
    const { photos: rawPhotos, ...rest } = obj;
    const incoming = checkBook(rest);
    if (rawPhotos != null && (typeof rawPhotos !== "object" || Array.isArray(rawPhotos)))
      throw Error("备份中的照片区格式无效。");
    const wanted = [...photoIdsIn(incoming)];
    const photos = new Map();
    let rejected = 0, absent = 0;
    if (wanted.length) show("合并这份备份", `<p class="muted" role="status">正在检查 ${wanted.length} 张照片…</p>`);
    for (const id of wanted) {
      const p = rawPhotos && Object.hasOwn(rawPhotos, id) ? rawPhotos[id] : null;
      if (!p) { absent++; continue; }
      try { photos.set(id, await verifyInline(id, p)); } catch { rejected++; }
    }
    const notes = incoming.players.reduce((n, p) => n + p.notes.length, 0);
    const photoLine = wanted.length
      ? `<p class="muted">照片：${photos.size} 张通过检查${[...photos.values()].some((r) => r.restored === "normalised") ? `（其中 ${[...photos.values()].filter((r) => r.restored === "normalised").length} 张带有额外信息，已在本机重新整理）` : ""}${rejected ? `；<strong>${rejected} 张不是有效照片，将跳过</strong>` : ""}${absent ? `；${absent} 张不在这份文件里（对应记录照常导入，只是没有照片）` : ""}。</p>`
      : "";
    show(
      "合并这份备份",
      `<p>文件有 <strong>${roster(incoming).length}</strong> 位牌手、<strong>${notes}</strong> 条记录。同一份档案按各栏的编辑时间合并；同一手牌保留较新版本，其余记录追加。</p>${photoLine}<div class="modal-actions">${button("取消", "close")}${button("确认合并", "merge", "", "solid")}</div><p id="form-error" class="error-msg" role="alert"></p>`,
      "restore",
    );
    pendingImport = { book: incoming, photos };
  }
  async function saveBackup(withPhotos) {
    const out = { ...book };
    delete out.photos;
    const ids = [...photoIdsIn(book)];
    let missing = 0;
    if (withPhotos && ids.length) {
      const found = await loadPhotos(ids);
      out.photos = {};
      for (const id of ids) {
        const rec = found.get(id);
        if (rec) out.photos[id] = toInline(rec);
        else missing++;
      }
    }
    const text = JSON.stringify(out, null, 2);
    if (text.length > MAX_BACKUP_BYTES)
      throw Error("备份超过 300 MB。请先用「不含照片的备份」保存文字。");
    const tag = withPhotos ? "" : "无照片-";
    await saveFile(`牌桌手记备份-${tag}${todayFile()}.json`, text, "application/json");
    const mb = (text.length / 1048576).toFixed(text.length < 10485760 ? 1 : 0);
    const kept = withPhotos ? ids.length - missing : 0;
    toast(`备份约 ${mb} MB${kept ? `，含 ${kept} 张照片` : withPhotos ? "" : "，不含照片"}${missing ? `；${missing} 张照片本机已缺失` : ""}`);
  }
  function showError(e) {
    const msg = e?.message || "操作失败，请再试。";
    if (dialog.open && $("#form-error")) $("#form-error").textContent = msg;
    else toast(msg);
  }
  const profileFields = ["name", "appearance", "exploit", "tags"];
  function fieldStamp(p, key) {
    return p.fieldTimes?.[key] || p.updatedAt || p.createdAt;
  }
  function updateProfile(p, values) {
    const stamp = now();
    const times = Object.fromEntries(
      profileFields.map((k) => [k, fieldStamp(p, k)]),
    );
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(p[key]) !== JSON.stringify(value)) {
        p[key] = value;
        times[key] = stamp;
      }
    }
    p.fieldTimes = times;
    p.updatedAt = stamp;
  }
  function fresh(name) {
    const t = now();
    return {
      id: uid(),
      name,
      appearance: "",
      exploit: "",
      tags: [],
      notes: [],
      createdAt: t,
      updatedAt: t,
      fieldTimes: Object.fromEntries(profileFields.map((k) => [k, t])),
    };
  }
  function requirePlayer(all, id) {
    const p = all.players.find((p) => p.id === id);
    if (!p) throw Error("找不到这位牌手，请重新打开档案。");
    return p;
  }
  async function saveForm(form) {
    const id = form.dataset.id;
    let nextId;
    if (form.id === "quick-form") return saveQuick();
    if (form.id === "assign-form") return assignNote(form);
    if (form.id === "board-form") {
      if (cardPicker?.rank)
        throw Error("这张牌还缺花色，请选择花色或点「收起」取消选牌。");
      if (!draft.photo) throw Error("照片已移除，请重新添加。");
      draft.board = [...draftCards.board];
      persistDraft();
      if (recog?.id === draft.photo.id) recog = { ...recog, state: "dismissed" };
      close();
      paintPhoto();
      return;
    }
    if (form.id === "profile-form") {
      const name = $("#pname").value.trim();
      if (!name) throw Error("请给牌手起一个昵称。");
      const appearance = $("#appearance").value.trim(),
        exploit = $("#longplay").value.trim(),
        tags = [
          ...new Set([
            ...newTags,
            ...$("#custom")
              .value.split(/[,，、\n]/)
              .map((t) => t.trim())
              .filter(Boolean),
          ]),
        ];
      if (tags.some((t) => t.length > 60))
        throw Error("每个标签最多 60 个字符。");
      await change((data) => {
        const p = id ? requirePlayer(data, id) : fresh(name);
        updateProfile(p, { name, appearance, exploit, tags });
        if (!id) data.players.push(p);
        nextId = p.id;
      });
      close();
      move("profile", nextId);
      toast("牌手档案已保存");
      return;
    }
    if (form.id === "exploit-form") {
      const exploit = $("#longplay").value.trim();
      await change((data) =>
        updateProfile(requirePlayer(data, id), { exploit }),
      );
      close();
      render();
      toast("长期剥削笔记已保存");
      return;
    }
    if (form.id === "note-form") {
      const oldId = form.dataset.note, target = form.dataset.player;
      const observation = $("#obs").value, reflection = $("#reflect").value,
        street = $("#street").value, atRaw = $("#note-time").value;
      const keepsPhoto = !!form.dataset.photo && !dropPhoto;
      if (
        !observation.trim() &&
        !reflection.trim() &&
        !keepsPhoto &&
        !Object.values(draftCards).some((a) => a.length)
      )
        throw Error("请写一句观察、选一张牌、保留照片，或填写你的复盘。");
      if (!atRaw || !Number.isFinite(Date.parse(atRaw)))
        throw Error("请选择有效的记录时间。");
      if (cardPicker?.rank)
        throw Error("这张牌还缺花色，请选择花色或点「收起」取消选牌。");
      const cards = Object.fromEntries(
        Object.entries(draftCards).map(([k, v]) => [k, [...v]]),
      );
      const stamp = now();
      await change((data) => {
        const p = requirePlayer(data, target);
        if (!p.fieldTimes)
          p.fieldTimes = Object.fromEntries(
            profileFields.map((k) => [k, fieldStamp(p, k)]),
          );
        const n = p.notes.find((x) => x.id === oldId);
        if (!n) throw Error("找不到原记录，请重新打开。");
        if ((n.updatedAt || n.at) !== form.dataset.version)
          throw Error("这条笔记已在另一窗口更新。请先复制你的修改，再重新打开。");
        const at =
          localTime(n.at) === atRaw
            ? n.at
            : new Date(atRaw).toISOString();
        Object.assign(n, {
          text: observation,
          reflection,
          street,
          at,
          updatedAt: stamp,
          ...cards,
        });
        if (!keepsPhoto) delete n.photo;
        p.updatedAt = stamp;
      });
      const dropped = !!form.dataset.photo && !keepsPhoto;
      close();
      render();
      toast("修改已保存");
      if (dropped) sweepLater();
    }
  }
  async function handle(action, id, owner) {
    if (photoBusy && blockedWhileBusy.has(action))
      throw Error("照片还在处理，请稍等几秒再切换草稿或牌手。");
    switch (action) {
      case "nav":
        move(id);
        break;
      case "profile":
        move("profile", id);
        break;
      case "profile-tab":
        selState.tab = id;
        render();
        break;
      case "add-player":
        profileForm();
        break;
      case "edit-player":
        profileForm(playerBy(id));
        break;
      case "exploit":
        exploitForm(playerBy(id));
        break;
      case "add-note":
        if (hasDraft(draft) && draft.target !== id) replaceDraft(newDraft());
        else if (draft.target !== (id || "")) draftSlot++;
        draft.target = id || "";
        move("notes");
        $("#quick-text").focus();
        break;
      case "detach-draft":
        draftSlot++;
        draft.target = "";
        writeDraft(draft.text);
        render();
        break;
      case "resume-draft": {
        const saved = availableDrafts().find((d) => d.value.id === id);
        if (saved) { loadDraft(saved); render(); $("#quick-text").focus(); }
        break;
      }
      case "assign":
        assignForm(owner, id);
        break;
      case "view-photo": {
        show("照片", `<img class="photo-full" alt="牌局照片"><p class="muted">本机保存的压缩副本。</p>`);
        await fillFull(modal.querySelector(".photo-full"), id);
        break;
      }
      case "remove-photo":
        photoSeq++;
        draft.photo = null;
        draft.board = [];
        recog = null;
        persistDraft();
        paintPhoto();
        sweepLater();
        break;
      case "board-scan":
        await scanStored();
        break;
      case "board-accept":
        if (recog?.state === "done" && recog.sure && draft.photo?.id === recog.id) {
          draft.board = recog.cards.map((c) => c.code);
          persistDraft();
          recog = { ...recog, state: "dismissed" };
          paintPhoto();
        }
        break;
      case "board-edit":
        boardForm();
        break;
      case "board-dismiss":
        if (recog) recog = { ...recog, state: "dismissed" };
        paintPhoto();
        break;
      case "toggle-photo": {
        dropPhoto = !dropPhoto;
        $("#photo-edit")?.classList.toggle("dropped", dropPhoto);
        const b = $("#photo-edit button.linkbtn");
        if (b) {
          b.textContent = dropPhoto ? "保留照片" : "移除照片";
          b.setAttribute("aria-pressed", String(dropPhoto));
        }
        break;
      }
      case "assign-existing":
        await assignNote($("#assign-form"), id);
        break;
      case "edit-note": {
        const p = playerBy(owner);
        if (p)
          noteForm(
            p,
            p.notes.find((n) => n.id === id),
          );
        break;
      }
      case "tag":
        newTags.has(id) ? newTags.delete(id) : newTags.add(id);
        drawTags();
        break;
      case "reset-filter":
        selState.filter = "";
        selState.query = "";
        render();
        break;
      case "pick-card": {
        const [group, i] = id.split("/");
        cardPicker = {
          group,
          index: Number(i),
          rank: draftCards[group][+i]?.[0] || null,
        };
        drawCards();
        break;
      }
      case "rank":
        if (cardPicker) {
          cardPicker.rank = id;
          drawCards();
        }
        break;
      case "suit":
        if (cardPicker?.rank) {
          draftCards[cardPicker.group][cardPicker.index] = cardPicker.rank + id;
          cardPicker = null;
          drawCards();
        }
        break;
      case "remove-card":
        if (cardPicker)
          draftCards[cardPicker.group].splice(cardPicker.index, 1);
        cardPicker = null;
        drawCards();
        break;
      case "dismiss-picker":
        cardPicker = null;
        drawCards();
        break;
      case "single-report":
        showSingle(playerBy(id));
        break;
      case "copy-single":
        await clip(engine.prompt(playerBy(id)));
        toast("已复制复盘材料");
        break;
      case "save-single":
        await saveFile(
          `单人复盘-${todayFile()}.md`,
          engine.prompt(playerBy(id)),
          "text/markdown;charset=utf-8",
        );
        break;
      case "period":
        selState.days = id === "all" ? "all" : Number(id);
        render();
        break;
      case "copy-md":
        await clip(engine.report(book.players, selState.days));
        toast("已复制复盘材料");
        break;
      case "export-md":
        await saveFile(
          `牌桌复盘-${todayFile()}.md`,
          engine.report(book.players, selState.days),
          "text/markdown;charset=utf-8",
        );
        break;
      case "backup":
        await saveBackup(true);
        break;
      case "backup-text":
        await saveBackup(false);
        break;
      case "restore":
        if (native) {
          const data = await native.importFile();
          if (data != null) await openImport(data);
        } else $("#restore-file").click();
        break;
      case "merge": {
        if (!pendingImport) return;
        const { book: incoming, photos } = pendingImport;
        await change((data) => {
          merge(data, incoming);
          syncPhotoMeta(data, photos);
        }, photos.size ? { save: [...photos.values()].map(({ restored, ...rec }) => rec) } : null);
        sweepLater();
        close();
        move("players");
        toast("完整备份已合并");
        break;
      }
      case "close":
        close();
        break;
    }
  }
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled || !ready) return;
    try {
      await handle(el.dataset.action, el.dataset.id, el.dataset.player);
    } catch (err) {
      showError(err);
    }
  });
  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      await saveForm(e.target);
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = false;
    }
  });
  document.addEventListener("change", async (e) => {
    try {
      if (e.target.id === "filter") {
        selState.filter = e.target.value;
        fillList();
      }
      if (e.target.id === "restore-file") {
        const f = e.target.files[0];
        e.target.value = "";
        if (f && f.size > MAX_BACKUP_BYTES) throw Error("备份文件超过 300 MB，无法在手机上安全读取。");
        if (f) await openImport(await f.text());
      }
      if (e.target.id === "photo-file") {
        const f = e.target.files[0];
        e.target.value = "";
        if (f) await addPhoto(f);
      }
    } catch (err) {
      showError(err);
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "quick-text") {
      writeDraft(e.target.value);
      syncComposer();
    }
    if (e.target.id === "assign-name") showAssignOptions();
    if (e.target.id === "search") {
      selState.query = e.target.value;
      fillList();
    }
    if (e.target.id === "note-search") {
      selState.noteQuery = e.target.value;
      $("#timeline-list").innerHTML = timelineList();
      hydratePhotos($("#timeline-list"));
    }
  });
  function setupOffline() {
    const update = (text) => {
      offlineStatus = text;
      const field = $("#offline-status");
      if (field) field.textContent = text;
    };
    if (!window.isSecureContext || location.protocol === "file:") {
      update("当前试用地址需要连接 Mac 所在的 Wi-Fi。");
      return;
    }
    if (!navigator.serviceWorker) {
      update("此浏览器暂时无法准备离线使用。");
      return;
    }
    const workers = navigator.serviceWorker;
    const script = new URL("./sw.js", location.href);
    const controlled = () => workers.controller?.scriptURL === script.href;
    const sync = () => {
      if (controlled()) update("离线已就绪，可以断网打开和记牌。");
    };
    const failed = () => {
      if (!controlled()) update("离线尚未就绪，请联网后重新打开。");
    };
    const watch = (worker) => {
      if (!worker) return;
      const onChange = () => {
        if (worker.state === "redundant") failed();
        else sync();
      };
      worker.addEventListener("statechange", onChange);
      onChange();
    };
    workers.addEventListener("controllerchange", sync);
    // Our worker only takes control after install has cached the complete app.
    sync();
    workers.register(script.href).then((registration) => {
      registration.addEventListener("updatefound", () => watch(registration.installing));
      watch(registration.installing);
      sync();
    }).catch(failed);
  }
  async function init() {
    $("#today").textContent = fmt(now(), {
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    try {
      if (native) {
        book = native.initialData ? checkBook(native.initialData) : emptyBook();
      } else {
        database = await openDb();
        book = await readDb();
      }
      const recovered = availableDrafts()[0];
      if (recovered) loadDraft(recovered);
      ready = true;
      render();
      $("#quick-text").focus({ preventScroll: true });
      if (!native) sweepLater();
    } catch (e) {
      root.innerHTML = `<div class="panel"><h1>无法打开本机存档</h1><p>${esc(e?.message || "请检查浏览器是否允许本地存储，并重新打开。")}</p></div>`;
      return;
    }
    if (!native) {
      setupOffline();
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible" && !dialog.open) {
          try {
            book = await readDb();
            if (selState.page === "notes" && $("#timeline-list")) {
              $("#timeline-list").innerHTML = timelineList();
              hydratePhotos($("#timeline-list"));
            } else render();
          } catch (e) {
            showError(e);
          }
        }
      });
    }
  }
  init();
})();
