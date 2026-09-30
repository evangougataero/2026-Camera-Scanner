--- a.js	2026-09-30 04:15:09.060811840 +0000
+++ b.js	2026-09-30 04:15:09.062874252 +0000
@@ -7951,13 +7951,29 @@
       .filter(Boolean);
 
   /*
-    A "price line" is a line that contains NOTHING but one or
-    two dollar amounts - e.g. "$300 $350" or just "$300". This
-    intentionally excludes lines like "$4.7 rating-star" or
-    prose that happens to mention a dollar figure.
+    A "price line" is a line whose ONLY content is one or two
+    dollar amounts, optionally followed by a short status tag
+    that Marketplace renders on the same line, e.g.:
+
+      $300
+      $185 $250          (second = crossed-out "was" price)
+      $250. In stock
+      $110 As Is
+
+    Lines like "Ships for $13.18" do not start with "$", so
+    shipping costs can never be mistaken for the ask.
   */
   const priceLinePattern =
-    /^\$([\d,]+(?:\.\d{2})?)(?:\s+\$(?:[\d,]+(?:\.\d{2})?))?$/;
+    /^\$\s?([\d,]+(?:\.\d{1,2})?)\.?(?:\s+\$\s?[\d,]+(?:\.\d{1,2})?)?\.?(?:\s+(?:in stock|as is|free shipping))?$/i;
+
+  /*
+    Lines that Marketplace renders directly AFTER the price in
+    the open-listing panel. Observed in real scans:
+    "Ships for $x", "Estimated arrival ...", "Message",
+    "Details", "Condition", "Listed ... ago", "In stock", "As Is".
+  */
+  const afterPriceMarkerPattern =
+    /^(ships for|estimated arrival|message\b|details\b|condition\b|listed\b|in stock|as is\b|free shipping|make an offer|buy now)|\bago\b/i;
 
   function parseAmount(str) {
     const value =
@@ -7972,67 +7988,111 @@
       : null;
   }
 
-  /*
-    PRIMARY: anchor on the listing title.
+  function normalize(text) {
+    return String(text || "")
+      .toLowerCase()
+      .replace(/[^a-z0-9]+/g, " ")
+      .trim();
+  }
 
-    The current ask reliably appears within a line or two
-    directly below the title in Marketplace's rendered layout.
+  /*
+    PRIMARY: anchor on the listing title, but tolerate title
+    wrapping. The open-listing title is usually wrapped over
+    2-4 OCR lines (e.g. "Nikon D3200 DSLR Camera" / "w/ 18-55mm
+    Lens"), so an exact single-line equality test almost never
+    matched and the old code silently fell through to the
+    whole-page DOM scrape.
   */
-  const normalizedTitle =
-    String(title || "").trim().toLowerCase();
+  const titleNorm = normalize(title);
+  const titleTokens =
+    new Set(titleNorm.split(" ").filter(Boolean));
+
+  if (titleTokens.size >= 2) {
+    for (let i = 0; i < lines.length; i++) {
+      let acc = "";
 
-  if (normalizedTitle) {
-    const titleIndex =
-      lines.findIndex(
-        line => line.toLowerCase() === normalizedTitle
-      );
-
-    if (titleIndex !== -1) {
       for (
-        let i = titleIndex + 1;
-        i < Math.min(titleIndex + 3, lines.length);
-        i++
+        let e = i;
+        e < Math.min(i + 4, lines.length);
+        e++
       ) {
-        const match =
-          lines[i].match(priceLinePattern);
+        acc = (acc + " " + lines[e]).trim();
 
-        if (match) {
-          return parseAmount(match[1]);
+        const accTokens =
+          normalize(acc).split(" ").filter(Boolean);
+
+        if (accTokens.length > titleTokens.size + 2) {
+          break;
+        }
+
+        let overlap = 0;
+        for (const t of accTokens) {
+          if (titleTokens.has(t)) overlap++;
+        }
+
+        const coversTitle =
+          overlap / titleTokens.size >= 0.85;
+        const mostlyTitle =
+          accTokens.length > 0 &&
+          overlap / accTokens.length >= 0.85;
+
+        if (!coversTitle || !mostlyTitle) {
+          continue;
+        }
+
+        for (
+          let j = e + 1;
+          j < Math.min(e + 4, lines.length);
+          j++
+        ) {
+          const m = lines[j].match(priceLinePattern);
+          if (m) return parseAmount(m[1]);
         }
       }
     }
   }
 
   /*
-    FALLBACK: anchor on the "Listed ... ago" metadata line,
-    which consistently follows the price line even when the
-    title didn't match exactly (OCR noise, truncation, etc.).
+    FALLBACK: first price line that is immediately followed by
+    a detail-panel marker line (Ships for / Message / Details /
+    Condition / Listed ... ago / In stock / As Is ...).
+    The old fallback only accepted "Listed ... ago", which does
+    not appear in the screenshots this scanner takes.
   */
   for (let i = 0; i < lines.length; i++) {
-    const match =
-      lines[i].match(priceLinePattern);
+    const m = lines[i].match(priceLinePattern);
+    if (!m) continue;
 
-    if (!match) {
-      continue;
-    }
-
-    const nextFewLines =
-      lines
-        .slice(i + 1, i + 3)
-        .join(" ")
-        .toLowerCase();
+    const next = lines.slice(i + 1, i + 5);
 
-    if (
-      nextFewLines.includes("listed") ||
-      nextFewLines.includes(" ago")
-    ) {
-      return parseAmount(match[1]);
+    if (next.some(line => afterPriceMarkerPattern.test(line))) {
+      return parseAmount(m[1]);
     }
   }
 
   return null;
 }
 
+/*
+  Every dollar amount that appears anywhere in the OCR text.
+  Used to sanity-check a DOM-scraped price: if the DOM price
+  is not visible anywhere in the listing screenshot, it came
+  from some other tile on the page and must not be trusted.
+*/
+function collectOcrDollarAmounts(ocrText) {
+  const amounts = new Set();
+  const re = /\$\s?([\d,]+(?:\.\d{1,2})?)/g;
+  const text = String(ocrText || "");
+  let m;
+
+  while ((m = re.exec(text)) !== null) {
+    const v = Number(m[1].replace(/,/g, ""));
+    if (Number.isFinite(v) && v > 0) amounts.add(v);
+  }
+
+  return amounts;
+}
+
 async function showSessionListingsLibrary() {
   const stored = await chrome.storage.local.get(SESSION_LISTINGS_KEY);
 
@@ -10238,6 +10298,39 @@
 
 if (ocrAnchoredPrice != null) {
   facebookPrice = ocrAnchoredPrice;
+} else if (facebookPrice != null) {
+  /*
+    OCR could not anchor the price. The DOM scrape is not
+    scoped to the open listing and can return a price from an
+    unrelated tile, so only keep it when that exact amount is
+    actually visible in the listing screenshot. If the
+    screenshot shows dollar amounts but NOT this one, discard
+    it rather than evaluate the deal against a wrong ask.
+  */
+  const ocrAmounts =
+    collectOcrDollarAmounts(listingScreenshotOcr);
+
+  if (
+    ocrAmounts.size > 0 &&
+    !ocrAmounts.has(facebookPrice)
+  ) {
+    console.warn(
+      "[STEP 1A] Discarding DOM-scraped price $" +
+      facebookPrice +
+      " - not present in listing OCR. OCR amounts:",
+      Array.from(ocrAmounts)
+    );
+
+    facebookPrice = null;
+  } else {
+    console.warn(
+      "[STEP 1A] OCR price anchor failed; using DOM price $" +
+      facebookPrice +
+      " (confirmed present in OCR: " +
+      (ocrAmounts.size > 0) +
+      ")"
+    );
+  }
 }
 
 /*