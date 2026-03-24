// ── Gemini MD Content Extractor ──
(function () {
  "use strict";

  const TAG = "[LLM2OBS]";

  function safeSendMessage(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_) {}
  }

  // ── Find all MD chips on page ──
  function findMdChips() {
    const chips = [];
    const seen = new Set();

    document.querySelectorAll('[data-test-id="file-name"]').forEach((el) => {
      const title = el.getAttribute("title") || el.textContent.trim();
      if ((title.endsWith(".md") || title.includes(".md")) && !seen.has(title)) {
        seen.add(title);
        chips.push({ fileName: title, el: el.closest(".chip") || el });
      }
    });

    document.querySelectorAll(".file-type").forEach((el) => {
      if (el.textContent.trim().toUpperCase() === "MD") {
        const chip = el.closest(".chip");
        if (chip) {
          const nameEl = chip.querySelector('[data-test-id="file-name"]');
          const fileName = nameEl?.getAttribute("title") || nameEl?.textContent.trim() || "unknown.md";
          if (!seen.has(fileName)) {
            seen.add(fileName);
            chips.push({ fileName, el: chip });
          }
        }
      }
    });

    return chips;
  }

  // ── Score markdown likelihood ──
  function scoreMd(text) {
    let s = 0;
    if (text.match(/^#\s/m)) s += 3;
    if (text.match(/^##\s/m)) s += 2;
    if (text.match(/^###\s/m)) s += 1;
    if (text.match(/^-\s/m)) s += 1;
    if (text.match(/^\d+\.\s/m)) s += 1;
    if (text.startsWith("---")) s += 2;
    if (text.includes("```")) s += 1;
    if (text.match(/\*\*[^*]+\*\*/)) s += 1;
    if (text.length > 200) s += 1;
    return s;
  }

  // ── Strip Python wrapper ──
  function stripPyWrapper(text) {
    const m1 = text.match(/(?:content\s*=\s*(?:"""|'''))([\s\S]*?)(?:"""|''')/);
    if (m1) return m1[1].trim();
    const m2 = text.match(/\.write\((?:"""|''')([\s\S]*?)(?:"""|''')\)/);
    if (m2) return m2[1].trim();
    return text;
  }

  // ── Extract all MD blocks from code blocks ──
  function extractAllMarkdownBlocks() {
    const blocks = [];
    const seen = new Set();

    document.querySelectorAll("code-block pre, pre").forEach((el) => {
      let text = el.textContent || "";
      if (text.length < 50) return;

      // Deduplicate (pre inside code-block)
      const key = text.slice(0, 100);
      if (seen.has(key)) return;
      seen.add(key);

      text = stripPyWrapper(text);
      const score = scoreMd(text);
      if (score >= 3) {
        // Try to extract a title from the content
        let title = null;
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("# ") && !trimmed.startsWith("# {")) {
            title = trimmed.slice(2).trim();
            break;
          }
        }
        blocks.push({
          content: text,
          score,
          title: title || `Block (${text.length} chars)`,
          length: text.length,
        });
      }
    });

    blocks.sort((a, b) => b.score - a.score || b.length - a.length);
    return blocks;
  }

  // ── Build combined list: match chips to blocks or standalone ──
  function getAllMdItems() {
    const chips = findMdChips();
    const blocks = extractAllMarkdownBlocks();

    const items = [];

    // If we have matching chips and blocks, pair them
    if (chips.length > 0 && blocks.length > 0) {
      // Use chips as labels, blocks as content (in order)
      for (let i = 0; i < Math.max(chips.length, blocks.length); i++) {
        const chip = chips[i];
        const block = blocks[i];
        items.push({
          fileName: chip?.fileName || block?.title || `item-${i + 1}`,
          title: block?.title || chip?.fileName || `item-${i + 1}`,
          content: block?.content || null,
          score: block?.score || 0,
          length: block?.content?.length || 0,
        });
      }
    } else if (blocks.length > 0) {
      // No chips, just blocks
      blocks.forEach((b, i) => {
        items.push({
          fileName: `${b.title}.md`,
          title: b.title,
          content: b.content,
          score: b.score,
          length: b.length,
        });
      });
    } else if (chips.length > 0) {
      // Chips but no extractable blocks
      chips.forEach((c) => {
        items.push({
          fileName: c.fileName,
          title: c.fileName,
          content: null,
          score: 0,
          length: 0,
        });
      });
    }

    return items;
  }

  // ── Message listener ──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(TAG, "Message:", message.action);

    if (message.action === "scanMdItems") {
      const items = getAllMdItems();
      console.log(TAG, `Found ${items.length} MD items`);
      // Don't send full content in scan (just metadata)
      sendResponse(items.map((it, i) => ({
        index: i,
        fileName: it.fileName,
        title: it.title,
        length: it.length,
        hasContent: !!it.content,
      })));
      return true;
    }

    if (message.action === "getMarkdownContent") {
      // Return single best block (for context menu)
      const items = getAllMdItems().filter((it) => it.content);
      const best = items[items.length - 1]; // last one
      console.log(TAG, "Best item:", best?.title, best?.length);
      sendResponse({ content: best?.content || null });
      return true;
    }

    if (message.action === "getMarkdownByIndex") {
      const items = getAllMdItems();
      const idx = message.index;
      const item = items[idx];
      console.log(TAG, `Item ${idx}:`, item?.title, item?.length);
      sendResponse({ content: item?.content || null, fileName: item?.fileName });
      return true;
    }

    if (message.action === "debugScan") {
      sendResponse({
        url: location.href,
        chips: findMdChips().map((c) => c.fileName),
        blocks: extractAllMarkdownBlocks().map((b) => ({ title: b.title, score: b.score, length: b.length })),
      });
      return true;
    }
  });

  // ── Badge (debounced) ──
  let badgeTimer = null;
  const observer = new MutationObserver(() => {
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      try {
        const count = findMdChips().length;
        if (count > 0) safeSendMessage({ action: "mdLinksCount", count });
      } catch (_) { observer.disconnect(); }
    }, 2000);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial badge
  const initCount = findMdChips().length;
  if (initCount > 0) safeSendMessage({ action: "mdLinksCount", count: initCount });
  console.log(TAG, "Loaded on", location.href);
})();
