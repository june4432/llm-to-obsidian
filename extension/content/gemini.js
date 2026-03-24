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
          el,
        });
      }
    });

    blocks.sort((a, b) => b.score - a.score || b.length - a.length);
    return blocks;
  }

  // ── Build list: chips with nearby content, then standalone blocks ──
  function getAllMdItems() {
    const chips = findMdChips();
    const blocks = extractAllMarkdownBlocks();
    const usedBlockIndices = new Set();
    const items = [];

    // For each chip, find the closest code block by DOM proximity
    chips.forEach((chip) => {
      let bestBlock = null;
      let bestDist = Infinity;

      blocks.forEach((block, blockIdx) => {
        if (usedBlockIndices.has(blockIdx)) return;
        // Compare DOM positions
        const chipRect = chip.el.getBoundingClientRect();
        const blockEl = block.el;
        if (!blockEl) return;
        const blockRect = blockEl.getBoundingClientRect();
        // Distance: prefer blocks ABOVE the chip (code block comes before download chip)
        const dist = Math.abs(chipRect.top - blockRect.bottom);
        if (dist < bestDist) {
          bestDist = dist;
          bestBlock = { ...block, idx: blockIdx };
        }
      });

      items.push({
        type: "chip",
        fileName: chip.fileName,
        title: chip.fileName,
        content: bestBlock?.content || null,
        score: bestBlock?.score || 0,
        length: bestBlock?.content?.length || 0,
      });

      if (bestBlock) usedBlockIndices.add(bestBlock.idx);
    });

    // Add remaining blocks that weren't matched to a chip
    blocks.forEach((block, idx) => {
      if (usedBlockIndices.has(idx)) return;
      items.push({
        type: "block",
        fileName: `${block.title}.md`,
        title: block.title,
        content: block.content,
        score: block.score,
        length: block.length,
      });
    });

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
        type: it.type,
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
