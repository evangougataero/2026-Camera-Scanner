const GOOGLE_LENS_PROMPT =
  "Identify the camera(s) and lens(es) in this image if present. Simply list their full model names and don't provide any more information. If the camera or lens is too unclear to accurately identify, say so clearly instead of guessing.";

const MARKETPLACE_CONVERSATION_PARSE_ALARM =
  "marketplace-conversation-parse";

const MARKETPLACE_CONVERSATION_PARSE_INTERVAL_MINUTES =
  30;

  // ============================================================
// MESSENGER BACKGROUND CONVERSATION PARSER
//
// false = completely disabled
// true  = original 30-minute background parsing behavior
// ============================================================

const MARKETPLACE_CONVERSATION_PARSER_ENABLED = false;

const MARKETPLACE_CONVERSATION_PARSE_TAB_KEY =
  "marketplaceConversationParseTabId";

const MARKETPLACE_CONVERSATION_PARSE_RUNNING_KEY =
  "marketplaceConversationParseRunning";

const MARKETPLACE_CONVERSATION_SERVER =
  "http://127.0.0.1:3000";

  function sleepBackground(
  ms
) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

initializeMarketplaceConversationParser()
  .catch(
    error => {
      console.error(
        "[CONVERSATION PARSER] Initialization failed:",
        error
      );
    }
  );


async function waitForBackgroundFacebookTab(
  tabId,
  timeoutMs = 20000
) {
  const startedAt =
    Date.now();


  while (
    Date.now() -
      startedAt <
    timeoutMs
  ) {
    try {
      const tab =
        await chrome.tabs.get(
          tabId
        );


      if (
        tab?.status ===
        "complete"
      ) {
        /*
          Facebook's DOM needs extra time after the
          browser declares the document loaded.
        */
        await sleepBackground(
          1800
        );

        return true;
      }

    } catch (error) {
      return false;
    }


    await sleepBackground(
      500
    );
  }


  return false;
}

async function getOrCreateMarketplaceConversationParseTab() {
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_CONVERSATION_PARSE_TAB_KEY
    );


  const storedTabId =
    Number(
      stored[
        MARKETPLACE_CONVERSATION_PARSE_TAB_KEY
      ] || 0
    );


  if (storedTabId) {
    try {
      const existing =
        await chrome.tabs.get(
          storedTabId
        );

      if (existing?.id) {
        return existing;
      }

    } catch (error) {
      /*
        Stored tab no longer exists.
      */
    }
  }


  const tab =
    await chrome.tabs.create({
      url:
        "https://www.facebook.com/messages/",

      active:
        false
    });


  if (!tab?.id) {
    throw new Error(
      "Could not create Messenger parsing tab."
    );
  }


  await chrome.storage.local.set({
    [MARKETPLACE_CONVERSATION_PARSE_TAB_KEY]:
      tab.id
  });


  return tab;
}

async function runMarketplaceConversationParseSession() {
  if (!MARKETPLACE_CONVERSATION_PARSER_ENABLED) {
    console.log(
      "[CONVERSATION PARSER] Scheduled run ignored because parser is disabled."
    );

    return;
  }

  /*
    Prevent overlapping 30-minute runs.
  */
  /*
    Prevent overlapping 30-minute runs.
  */
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_CONVERSATION_PARSE_RUNNING_KEY
    );


  if (
    stored[
      MARKETPLACE_CONVERSATION_PARSE_RUNNING_KEY
    ] === true
  ) {
    console.log(
      "[CONVERSATION PARSER] Session already running."
    );

    return;
  }


  await chrome.storage.local.set({
    [MARKETPLACE_CONVERSATION_PARSE_RUNNING_KEY]:
      true
  });


  const startedAt =
    Date.now();


  try {
    console.log(
      "[CONVERSATION PARSER] Starting scheduled P-conversation update."
    );


    /*
      STEP 1:
      Ask server for current P target set.
    */
    const response =
      await fetch(
        `${MARKETPLACE_CONVERSATION_SERVER}/marketplace-conversation-targets`,
        {
          method:
            "GET",

          cache:
            "no-store"
        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      data?.ok !== true
    ) {
      throw new Error(
        data?.error ||
        "Could not load Marketplace conversation targets."
      );
    }


    const allTargets =
      Array.isArray(
        data.targets
      )
        ? data.targets
        : [];


    /*
      We intentionally DO NOT crawl the inbox.

      Unmapped listings are simply reported.
    */
    const targets =
      allTargets.filter(
        target =>
          target.mapped ===
            true &&
          target.conversationUrl
      );


    const unmapped =
      allTargets.filter(
        target =>
          target.mapped !==
            true
      );


    console.log(
      "[CONVERSATION PARSER] Targets:",
      {
        totalP:
          allTargets.length,

        mapped:
          targets.length,

        unmapped:
          unmapped.map(
            target =>
              target.listingId
          )
      }
    );


    if (!targets.length) {
      console.log(
        "[CONVERSATION PARSER] No mapped P conversations to update."
      );

      return;
    }


    const tab =
      await getOrCreateMarketplaceConversationParseTab();


    const completed =
      [];

    const failed =
      [];


    /*
      STEP 2:
      Visit every mapped P conversation sequentially.
    */
    for (
      let index = 0;
      index < targets.length;
      index++
    ) {
      const target =
        targets[index];


      console.log(
        `[CONVERSATION PARSER] ${index + 1}/${targets.length}`,
        {
          listingId:
            target.listingId,

          conversationId:
            target.conversationId,

          sellerName:
            target.sellerName
        }
      );


      try {
        await chrome.tabs.update(
          tab.id,
          {
            url:
              target.conversationUrl,

            active:
              false
          }
        );


        const loaded =
          await waitForBackgroundFacebookTab(
            tab.id
          );


        if (!loaded) {
          throw new Error(
            "Messenger page timed out."
          );
        }


        /*
          Ask content.js inside that inactive tab
          to parse the current conversation.
        */
        const parsed =
          await chrome.tabs.sendMessage(
            tab.id,
            {
              type:
                "PARSE_MARKETPLACE_CONVERSATION_NOW"
            }
          );


        if (
          !parsed?.ok
        ) {
          throw new Error(
            parsed?.error ||
            parsed?.reason ||
            "Conversation parse failed."
          );
        }


        if (
          String(
            parsed.listingId ||
            ""
          ) !==
          String(
            target.listingId
          )
        ) {
          throw new Error(
            `Listing mismatch. Expected ${target.listingId}, parsed ${parsed.listingId || "none"}.`
          );
        }


        completed.push({
          listingId:
            target.listingId,

          conversationId:
            target.conversationId,

          status:
            parsed.status,

          lastMessageSender:
            parsed.lastMessageSender,

          lastMessageAt:
            parsed.lastMessageAt
        });


        console.log(
          "[CONVERSATION PARSER] Updated:",
          completed[
            completed.length -
            1
          ]
        );


        /*
          Small gap between Facebook navigations.
        */
        await sleepBackground(
          1200
        );

      } catch (error) {
        console.warn(
          "[CONVERSATION PARSER] Target failed:",
          {
            listingId:
              target.listingId,

            conversationId:
              target.conversationId,

            error:
              error?.message ||
              String(error)
          }
        );


        failed.push({
          listingId:
            target.listingId,

          conversationId:
            target.conversationId,

          error:
            error?.message ||
            String(error)
        });
      }
    }


    console.log(
      "[CONVERSATION PARSER] Session finished.",
      {
        durationSeconds:
          Math.round(
            (
              Date.now() -
              startedAt
            ) /
            1000
          ),

        targetCount:
          targets.length,

        completedCount:
          completed.length,

        failedCount:
          failed.length,

        unmappedCount:
          unmapped.length,

        completed,

        failed
      }
    );

  } catch (error) {
    console.error(
      "[CONVERSATION PARSER] Session failed:",
      error
    );

  } finally {
    await chrome.storage.local.set({
      [MARKETPLACE_CONVERSATION_PARSE_RUNNING_KEY]:
        false
    });
  }
}

async function initializeMarketplaceConversationParser() {
  if (MARKETPLACE_CONVERSATION_PARSER_ENABLED) {
    await ensureMarketplaceConversationParseAlarm();

    console.log(
      "[CONVERSATION PARSER] Enabled."
    );

    return;
  }

  /*
    Important:

    Merely stopping creation of the alarm is not enough,
    because Chrome may already have the old 30-minute
    alarm saved from a previous extension run.

    Explicitly remove it.
  */
  await chrome.alarms.clear(
    MARKETPLACE_CONVERSATION_PARSE_ALARM
  );

  /*
    Also close the old dedicated Messenger parsing tab,
    if one is still hanging around.
  */
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_CONVERSATION_PARSE_TAB_KEY
    );

  const tabId =
    Number(
      stored[
        MARKETPLACE_CONVERSATION_PARSE_TAB_KEY
      ] || 0
    );

  if (tabId) {
    try {
      await chrome.tabs.remove(
        tabId
      );
    } catch (error) {
      /*
        Fine if the tab was already closed.
      */
    }
  }

  await chrome.storage.local.remove(
    MARKETPLACE_CONVERSATION_PARSE_TAB_KEY
  );

  /*
    Reset this too in case the extension was reloaded
    during an old parsing session.
  */
  await chrome.storage.local.set({
    [MARKETPLACE_CONVERSATION_PARSE_RUNNING_KEY]:
      false
  });

  console.log(
    "[CONVERSATION PARSER] Disabled. Existing schedule and parser tab removed."
  );
}

async function ensureMarketplaceConversationParseAlarm() {
  const existing =
    await chrome.alarms.get(
      MARKETPLACE_CONVERSATION_PARSE_ALARM
    );


  if (existing) {
    return;
  }


 chrome.alarms.create(
  MARKETPLACE_CONVERSATION_PARSE_ALARM,
  {
    /*
      First run about 10 seconds after
      the extension starts/reloads.
    */
    delayInMinutes:
      10 / 60,

    /*
      Then run every 30 minutes.
    */
    periodInMinutes:
      MARKETPLACE_CONVERSATION_PARSE_INTERVAL_MINUTES
  }
);


  console.log(
    "[CONVERSATION PARSER] 30-minute schedule created."
  );
}


chrome.alarms.onAlarm.addListener(
  alarm => {
    if (
      alarm.name !==
      MARKETPLACE_CONVERSATION_PARSE_ALARM
    ) {
      return;
    }

    if (!MARKETPLACE_CONVERSATION_PARSER_ENABLED) {
      console.log(
        "[CONVERSATION PARSER] Alarm ignored because parser is disabled."
      );

      return;
    }

    runMarketplaceConversationParseSession()
      .catch(
        error => {
          console.error(
            "[CONVERSATION PARSER] Scheduled run failed:",
            error
          );
        }
      );
  }
);

function getGoogleProductPluralLabel(
  productType
) {
  const label =
    getGoogleProductLabel(
      productType
    );

  if (label === "camera body") {
    return "camera bodies";
  }

  if (label === "camera lens") {
    return "camera lenses";
  }

  if (label === "camera flash") {
    return "camera flashes";
  }

  return `${label}s`;
}

function buildGoogleLensPromptForGroup({
  productType,
  expectedCount,
  excludedModels = []
}) {
  const pluralLabel =
    getGoogleProductPluralLabel(
      productType
    );

  const cleanExcludedModels =
    Array.isArray(excludedModels)
      ? excludedModels
          .map(
            value =>
              String(
                value || ""
              ).trim()
          )
          .filter(Boolean)
      : [];

  let exclusionText = "";

  if (cleanExcludedModels.length) {
    exclusionText =
      ` Do NOT return any of these already-identified models: ` +
      `${cleanExcludedModels.join("; ")}.`;
  }

  return (
    `Identify ALL ${expectedCount} ${pluralLabel} in this image.` +
    exclusionText +
    ` Return ONLY the full model names of the ${expectedCount} ` +
    `${pluralLabel}, one model per line, and no other information. ` +
    `Do not omit a product because multiple products are visible. ` +
    `If one cannot be accurately identified, write UNKNOWN for that item.`
  );
}

function getGoogleProductLabel(
  productType
) {
  const type =
    String(
      productType || ""
    )
      .trim()
      .toLowerCase();

  if (
    type === "camera body" ||
    type === "camera"
  ) {
    return "camera body";
  }

  if (
    type === "camera lens" ||
    type === "lens"
  ) {
    return "camera lens";
  }

  if (
    type === "flash" ||
    type === "speedlite"
  ) {
    return "camera flash";
  }

  return "camera product";
}


function buildGoogleLensPromptForTarget({
  productType,
  excludedModels = []
}) {
  const label =
    getGoogleProductLabel(
      productType
    );

  const cleanExcludedModels =
    Array.isArray(excludedModels)
      ? excludedModels
          .map(
            value =>
              String(
                value || ""
              ).trim()
          )
          .filter(Boolean)
      : [];

  /*
    Normal case:
    only one lens/body of this type appears
    in the selected image.
  */
  if (!cleanExcludedModels.length) {
    return (
      `Identify the ${label} in this image. ` +
      `Return ONLY its full model name and no other information. ` +
      `If the ${label} cannot be accurately identified, return exactly UNKNOWN.`
    );
  }

  /*
    Ambiguous image:
    another product of the same type was already identified.
  */
  if (cleanExcludedModels.length === 1) {
    return (
      `Identify the ${label} in this image that is NOT ` +
      `${cleanExcludedModels[0]}. ` +
      `Return ONLY the full model name of the other ${label} ` +
      `and no other information. ` +
      `If the other ${label} cannot be accurately identified, ` +
      `return exactly UNKNOWN.`
    );
  }

  return (
    `Identify the ${label} in this image that is NOT any of ` +
    `the following already-identified products: ` +
    `${cleanExcludedModels.join("; ")}. ` +
    `Return ONLY the full model name of the remaining ${label} ` +
    `and no other information. ` +
    `If the remaining ${label} cannot be accurately identified, ` +
    `return exactly UNKNOWN.`
  );
}

function cleanGoogleIdentificationResult(
  value
) {
  let text =
    String(
      value || ""
    )
      .trim();

  if (!text) {
    return null;
  }

  /*
    Remove common wrapping characters.
  */
  text =
    text
      .replace(
        /^["'`]+/,
        ""
      )
      .replace(
        /["'`]+$/,
        ""
      )
      .trim();

  if (!text) {
    return null;
  }

  const normalized =
    text
      .toLowerCase()
      .trim();

  /*
    Explicit failure response.
  */
  if (
    normalized === "unknown" ||
    normalized === "unknown." ||
    normalized === "n/a" ||
    normalized === "null"
  ) {
    return null;
  }

  /*
    Safety for Google ignoring the exact UNKNOWN
    instruction and writing a sentence instead.
  */
  const failurePhrases = [
    "cannot identify",
    "can't identify",
    "unable to identify",
    "cannot accurately identify",
    "can't accurately identify",
    "unable to accurately identify",
    "too unclear",
    "not clear enough",
    "insufficient detail",
    "not enough detail"
  ];

  if (
    failurePhrases.some(
      phrase =>
        normalized.includes(
          phrase
        )
    )
  ) {
    return null;
  }

  /*
    A genuine model response should be short.
    Reject a paragraph/explanation.
  */
  if (text.length > 180) {
    return null;
  }

  /*
    Google occasionally adds simple prefixes despite
    being told not to.
  */
  text =
    text
      .replace(
        /^(?:the\s+)?(?:camera|camera body|camera lens|lens|flash)\s+(?:is|appears to be)\s*[:\-]?\s*/i,
        ""
      )
      .replace(
        /^model\s*[:\-]\s*/i,
        ""
      )
      .trim();

  return text || null;
}

/*
  Basic sleep for background.js.
*/
function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


/*
  Wait until Chrome reports that a tab has
  completed loading.

  If the page is already complete, this
  returns immediately.
*/

function cleanGoogleLensAiText(text) {
  return String(text || "")
    .replace(
      /\bAI responses may include mistakes\.?/gi,
      ""
    )
    .replace(
      /^\s*Show all\s*$/gim,
      ""
    )
    .replace(
      /^\s*Show more\s*$/gim,
      ""
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function waitForTabComplete(
  tabId,
  timeoutMs = 30000
) {
  const startedAt = Date.now();

  while (
    Date.now() - startedAt < timeoutMs
  ) {
    let tab;

    try {
      tab =
        await chrome.tabs.get(
          tabId
        );
    } catch (error) {
      throw new Error(
        `GOOGLE_TAB_CLOSED: ${
          error?.message ||
          String(error)
        }`
      );
    }

    if (
      tab.status ===
      "complete"
    ) {
      return tab;
    }

    await sleep(250);
  }

  const finalTab =
    await chrome.tabs
      .get(tabId)
      .catch(() => null);

  throw new Error(
    `GOOGLE_TAB_LOAD_TIMEOUT: ` +
    `Timed out waiting for Google tab to load. ` +
    `URL: ${
      finalTab?.url ||
      "unknown"
    }`
  );
}


async function waitForTabNavigation(
  tabId,
  previousUrl,
  timeoutMs = 30000
) {
  const startedAt =
    Date.now();

  let sawDifferentUrl =
    false;

  while (
    Date.now() - startedAt < timeoutMs
  ) {
    let tab;

    try {
      tab =
        await chrome.tabs.get(
          tabId
        );
    } catch (error) {
      throw new Error(
        `GOOGLE_TAB_CLOSED: ${
          error?.message ||
          String(error)
        }`
      );
    }

    const currentUrl =
      String(
        tab?.url || ""
      ).trim();

    if (
      currentUrl &&
      currentUrl !==
        previousUrl
    ) {
      sawDifferentUrl =
        true;
    }

    if (
      sawDifferentUrl &&
      tab.status ===
        "complete"
    ) {
      return tab;
    }

    await sleep(250);
  }

  const finalTab =
    await chrome.tabs
      .get(tabId)
      .catch(() => null);

  throw new Error(
    `GOOGLE_NAVIGATION_TIMEOUT: ` +
    `Google did not finish the expected navigation. ` +
    `Previous URL: ${
      previousUrl || "unknown"
    } ` +
    `Current URL: ${
      finalTab?.url || "unknown"
    }`
  );
}


function isStrongGoogleLensSessionUrl(
  value
) {
  try {
    const url =
      new URL(
        String(value || "")
      );

    const host =
      url.hostname
        .toLowerCase();

    if (
      host ===
        "lens.google.com" ||
      host.endsWith(
        ".lens.google.com"
      )
    ) {
      return true;
    }

    if (
      !host.includes(
        "google."
      )
    ) {
      return false;
    }

    return (
      url.searchParams.has(
        "vsrid"
      ) ||
      url.searchParams.has(
        "vsint"
      ) ||
      url.searchParams.get(
        "sclient"
      ) ===
        "multimodal-lens-web"
    );
  } catch (error) {
    return false;
  }
}


async function getGooglePageSignals(
  tabId
) {
  try {
    const result =
      await chrome.scripting
        .executeScript({
          target: {
            tabId
          },

          func: () => {
            const bodyText =
              String(
                document.body
                  ?.innerText ||
                ""
              )
                .replace(
                  /\s+/g,
                  " "
                )
                .trim();

            const lower =
              bodyText
                .toLowerCase();

            const challenge =
              lower.includes(
                "our systems have detected unusual traffic"
              ) ||
              lower.includes(
                "i'm not a robot"
              ) ||
              lower.includes(
                "before you continue to google"
              ) ||
              lower.includes(
                "verify you're human"
              ) ||
              lower.includes(
                "verify you are human"
              );

            const lensUi =
              lower.includes(
                "add to your search"
              ) ||
              lower.includes(
                "visual matches"
              ) ||
              lower.includes(
                "exact matches"
              );

            return {
              challenge,
              lensUi,
              title:
                document.title ||
                ""
            };
          }
        });

    return (
      result?.[0]?.result ||
      {
        challenge: false,
        lensUi: false,
        title: ""
      }
    );
  } catch (error) {
    return {
      challenge: false,
      lensUi: false,
      title: ""
    };
  }
}


async function waitForGoogleLensImageSession(
  tabId,
  initialUrl,
  timeoutMs = 35000
) {
  const startedAt =
    Date.now();

  let lastSignals = {
    challenge: false,
    lensUi: false,
    title: ""
  };

  let lastSignalCheckAt =
    0;

  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    let tab;

    try {
      tab =
        await chrome.tabs.get(
          tabId
        );
    } catch (error) {
      throw new Error(
        `GOOGLE_TAB_CLOSED: ${
          error?.message ||
          String(error)
        }`
      );
    }

    const currentUrl =
      String(
        tab?.url || ""
      ).trim();

    const lowerUrl =
      currentUrl
        .toLowerCase();

    const lowerTitle =
      String(
        tab?.title || ""
      )
        .toLowerCase();

    if (
      lowerUrl.includes(
        "/sorry/"
      ) ||
      lowerUrl.includes(
        "consent.google."
      ) ||
      lowerTitle.includes(
        "unusual traffic"
      )
    ) {
      throw new Error(
        `GOOGLE_CHALLENGE: ` +
        `Google returned a challenge/interstitial page. ` +
        `URL: ${currentUrl}`
      );
    }

    if (
      Date.now() -
        lastSignalCheckAt >=
      1000
    ) {
      lastSignals =
        await getGooglePageSignals(
          tabId
        );

      lastSignalCheckAt =
        Date.now();

      if (
        lastSignals.challenge
      ) {
        throw new Error(
          `GOOGLE_CHALLENGE: ` +
          `Google returned a human-verification ` +
          `or unusual-traffic page. ` +
          `URL: ${currentUrl}`
        );
      }
    }

    const hasStrongSession =
      isStrongGoogleLensSessionUrl(
        currentUrl
      );

    const hasUiBackedSession =
      currentUrl &&
      currentUrl !==
        initialUrl &&
      lastSignals.lensUi;

    if (
      tab.status ===
        "complete" &&
      (
        hasStrongSession ||
        hasUiBackedSession
      )
    ) {
      return currentUrl;
    }

    await sleep(250);
  }

  const finalTab =
    await chrome.tabs
      .get(tabId)
      .catch(() => null);

  throw new Error(
    `GOOGLE_LENS_SESSION_TIMEOUT: ` +
    `Google never produced a usable Lens image session. ` +
    `URL: ${
      finalTab?.url ||
      "unknown"
    }`
  );
}

async function navigateLensWithTextPrompt(
  tabId,
  prompt
) {
  const tab =
    await chrome.tabs.get(tabId);

  const currentUrl =
    String(tab?.url || "").trim();

  if (!currentUrl) {
    throw new Error(
      "Could not get current Google Lens URL."
    );
  }

  console.log(
    "[GOOGLE LENS TEST] Current image-only Lens URL:",
    currentUrl
  );

  const url =
    new URL(currentUrl);

  /*
    Convert the existing IMAGE-ONLY Lens request
    into Google's multimodal IMAGE + TEXT request.

    Critically, we preserve Google's existing
    vsrid / vsint / session information instead
    of trying to rebuild the Lens URL ourselves.
  */
  url.searchParams.set(
    "q",
    prompt
  );

  url.searchParams.set(
    "oq",
    prompt
  );

  url.searchParams.set(
    "lns_mode",
    "mu"
  );

  url.searchParams.set(
    "udm",
    "24"
  );

  url.searchParams.set(
    "sclient",
    "multimodal-lens-web"
  );

  url.searchParams.set(
    "lns_fp",
    "1"
  );

  url.searchParams.set(
    "stq",
    "1"
  );

  url.searchParams.set(
    "cs",
    "1"
  );

  /*
    qsubts is just a timestamp-like query parameter
    Google uses in these Lens URLs.
  */
  url.searchParams.set(
    "qsubts",
    String(Date.now())
  );

const multimodalUrl =
  url.toString();

console.log(
  "[GOOGLE LENS TEST] Navigating existing Lens tab to multimodal URL:",
  multimodalUrl
);


/*
  Reuse the SAME Lens tab.

  No second/fresh Chrome tab is created.
*/
await chrome.tabs.update(
  tabId,
  {
    url:
      multimodalUrl
  }
);


await waitForTabNavigation(
  tabId,
  currentUrl,
  30000
);


return multimodalUrl;
}

/*
  PHASE 1

  Runs on:

      google.com/search?udm=49&udf=257

  Opens Google's Search-by-image dialog,
  inserts the Marketplace image URL,
  and clicks Search.

  We intentionally return immediately after
  clicking Search because Google may navigate
  away from this document.
*/
async function submitImageToGoogle(
  imageUrl
) {
  const sleep = ms =>
    new Promise(
      resolve =>
        setTimeout(resolve, ms)
    );


  function isVisible(element) {
    if (!element) {
      return false;
    }

    const rect =
      element.getBoundingClientRect();

    const style =
      window.getComputedStyle(
        element
      );

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }


  async function waitForElement(
    getElement,
    timeoutMs = 10000
  ) {
    const startedAt =
      Date.now();

    while (
      Date.now() -
        startedAt <
      timeoutMs
    ) {
      const element =
        getElement();

      if (
        element &&
        isVisible(element)
      ) {
        return element;
      }

      await sleep(250);
    }

    return null;
  }


  function setNativeInputValue(
    input,
    value
  ) {
    const prototype =
      input instanceof
        HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;


    const setter =
      Object
        .getOwnPropertyDescriptor(
          prototype,
          "value"
        )
        ?.set;


    if (setter) {
      setter.call(
        input,
        value
      );
    } else {
      input.value =
        value;
    }


    input.dispatchEvent(
      new InputEvent(
        "input",
        {
          bubbles: true,
          composed: true,
          inputType:
            "insertText",
          data:
            value
        }
      )
    );


    input.dispatchEvent(
      new Event(
        "change",
        {
          bubbles: true
        }
      )
    );
  }


  console.log(
    "[GOOGLE LENS TEST] Finding Search by image button..."
  );


  const searchByImageButton =
    await waitForElement(
      () => {
        const direct =
          document.querySelector(
            '[aria-label="Search by image"]'
          );

        if (
          direct &&
          isVisible(direct)
        ) {
          return direct;
        }


        return (
          Array
            .from(
              document.querySelectorAll(
                'button, [role="button"]'
              )
            )
            .find(
              element => {
                const label =
                  String(
                    element.getAttribute(
                      "aria-label"
                    ) ||
                    ""
                  )
                    .trim()
                    .toLowerCase();


                return (
                  isVisible(
                    element
                  ) &&
                  label.includes(
                    "search by image"
                  )
                );
              }
            ) ||
          null
        );
      }
    );


  if (!searchByImageButton) {
    throw new Error(
      'Could not find "Search by image".'
    );
  }


  searchByImageButton.click();


  console.log(
    "[GOOGLE LENS TEST] Opened Search by image."
  );


  await sleep(700);


  /*
    Find the Paste image link field.
  */
  const imageUrlInput =
    await waitForElement(
      () => {
        const fields =
          Array.from(
            document.querySelectorAll(
              'input, textarea'
            )
          );


        return (
          fields.find(
            input => {
              if (
                !isVisible(input)
              ) {
                return false;
              }

              const info = [
                input.placeholder,
                input.getAttribute(
                  "aria-label"
                ),
                input.name
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();


              return (
                info.includes(
                  "image link"
                ) ||
                info.includes(
                  "paste image"
                ) ||
                info.includes(
                  "image url"
                ) ||
                info.includes(
                  "paste"
                )
              );
            }
          ) ||

          fields.find(
            input => {
              if (
                !isVisible(input)
              ) {
                return false;
              }

              return (
                String(
                  input.name ||
                  ""
                ).toLowerCase() !==
                "q"
              );
            }
          ) ||

          null
        );
      }
    );


  if (!imageUrlInput) {
    throw new Error(
      "Could not find Google's Paste image link field."
    );
  }


  imageUrlInput.focus();


  setNativeInputValue(
    imageUrlInput,
    imageUrl
  );


  console.log(
    "[GOOGLE LENS TEST] Image URL inserted."
  );


  await sleep(500);


  /*
    Find Search button.
  */
  let searchButton =
    null;

  let container =
    imageUrlInput;


  for (
    let level = 0;
    level < 7 &&
    container;
    level++
  ) {
    searchButton =
      Array
        .from(
          container.querySelectorAll?.(
            'button, [role="button"]'
          ) ||
          []
        )
        .find(
          element => {
            if (
              !isVisible(
                element
              )
            ) {
              return false;
            }


            const text =
              String(
                element.innerText ||
                element.textContent ||
                element.getAttribute(
                  "aria-label"
                ) ||
                ""
              )
                .trim()
                .toLowerCase();


            return (
              text === "search" ||
              text ===
                "search image"
            );
          }
        );


    if (searchButton) {
      break;
    }

    container =
      container.parentElement;
  }


  if (!searchButton) {
    searchButton =
      Array
        .from(
          document.querySelectorAll(
            'button, [role="button"]'
          )
        )
        .find(
          element => {
            if (
              !isVisible(
                element
              )
            ) {
              return false;
            }


            const text =
              String(
                element.innerText ||
                element.textContent ||
                element.getAttribute(
                  "aria-label"
                ) ||
                ""
              )
                .trim()
                .toLowerCase();


            return (
              text ===
              "search"
            );
          }
        );
  }


  if (!searchButton) {
    throw new Error(
      "Could not find Google image Search button."
    );
  }


  console.log(
    "[GOOGLE LENS TEST] Clicking image Search."
  );


  searchButton.click();


  return {
    submitted: true
  };
}


/*
  PHASE 2

  Runs once Google Lens results are visible.

  Your screenshot shows the field at the top
  containing:

      Add to your search

  This function puts the identification prompt
  into that box and submits it.
*


/*
  PHASE 3

  Wait for the AI Overview and return
  its text.

  We deliberately use visible text/semantic
  labels rather than Google's generated class
  names.
*/
async function extractAiOverview() {
  const sleep = ms =>
    new Promise(
      resolve =>
        setTimeout(resolve, ms)
    );

  const startedAt =
    Date.now();

  const timeoutMs =
    45000;

  const startMarker =
    "AI Overview";

  const endMarker =
    "AI can make mistakes, so double-check responses";


  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    /*
      ========================================
      STEP 1
      PHYSICALLY SELECT THE ENTIRE PAGE
      ========================================

      This intentionally reproduces the old
      visible Ctrl+A-style highlighting.
    */
    const selection =
      window.getSelection();

    if (!selection) {
      await sleep(500);
      continue;
    }

    selection.removeAllRanges();

    const range =
      document.createRange();

    range.selectNodeContents(
      document.body
    );

    selection.addRange(
      range
    );


    /*
      ========================================
      STEP 2
      PHYSICALLY COPY THE SELECTION
      ========================================

      This is the old-style browser copy path.

      We still use selection.toString() as the
      actual text source afterward so we do not
      depend on clipboard-read permissions.
    */
    let copiedSuccessfully =
      false;

    try {
      copiedSuccessfully =
        document.execCommand(
          "copy"
        );
    } catch (error) {
      copiedSuccessfully =
        false;
    }


    /*
      The selected text is effectively the same
      page text that was copied to the clipboard.
    */
    const copiedPageText =
      String(
        selection.toString() ||
        ""
      ).trim();


    console.log(
      "[GOOGLE PAGE COPY]",
      {
        copiedSuccessfully,
        copiedTextLength:
          copiedPageText.length
      }
    );


    if (!copiedPageText) {
      await sleep(500);
      continue;
    }


    /*
      Detect Google's challenge pages before
      attempting extraction.
    */
    const lowerText =
      copiedPageText
        .toLowerCase();

    if (
      lowerText.includes(
        "our systems have detected unusual traffic"
      ) ||
      lowerText.includes(
        "i'm not a robot"
      ) ||
      lowerText.includes(
        "verify you're human"
      ) ||
      lowerText.includes(
        "verify you are human"
      )
    ) {
      selection.removeAllRanges();

      return {
        found:
          false,

        code:
          "GOOGLE_CHALLENGE",

        text:
          "Google displayed a human-verification or unusual-traffic page."
      };
    }


    /*
      ========================================
      STEP 3
      CUT EVERYTHING ABOVE AI OVERVIEW
      ========================================
    */
    const startIndex =
      copiedPageText.indexOf(
        startMarker
      );

    if (
      startIndex === -1
    ) {
      /*
        AI Overview has not appeared yet.

        Leave the selection visible briefly,
        then retry.
      */
      await sleep(500);
      continue;
    }


    const answerStart =
      startIndex +
      startMarker.length;


    /*
      ========================================
      STEP 4
      CUT EVERYTHING BELOW GOOGLE'S AI FOOTER
      ========================================
    */
    const endIndex =
      copiedPageText.indexOf(
        endMarker,
        answerStart
      );


    /*
      Do NOT accept the answer until this marker
      appears.

      Its appearance is also a useful indication
      that Google's AI response has finished.
    */
    if (
      endIndex === -1
    ) {
      await sleep(500);
      continue;
    }


    /*
      ========================================
      STEP 5
      KEEP ONLY THE AI ANSWER
      ========================================
    */
    let extractedText =
      copiedPageText
        .slice(
          answerStart,
          endIndex
        )
        .trim();


    /*
      Remove excessive blank lines while
      preserving one-model-per-line output.
    */
    extractedText =
      extractedText
        .split("\n")
        .map(
          line =>
            line.trim()
        )
        .filter(Boolean)
        .join("\n")
        .trim();


    console.log(
      "[GOOGLE PAGE COPY] Extracted AI answer:"
    );

    console.log(
      extractedText
    );


    if (
      extractedText
    ) {
      /*
        Clear the visible selection only after
        extraction succeeded.

        If you WANT to visually keep the page
        highlighted until the tab closes, delete
        this removeAllRanges() call.
      */
      selection.removeAllRanges();

      return {
        found:
          true,

        code:
          "GOOGLE_AI_TEXT_COPIED",

        text:
          extractedText
      };
    }


    await sleep(500);
  }


  /*
    Timed out without finding a complete
    AI Overview response.
  */
  try {
    window
      .getSelection()
      ?.removeAllRanges();
  } catch (error) {
    // Non-fatal.
  }


  return {
    found:
      false,

    code:
      "GOOGLE_AI_RESULT_TIMEOUT",

    text:
      ""
  };
}

async function submitDataUrlImageToGoogle(
  dataUrl
) {
  const sleep = ms =>
    new Promise(
      resolve =>
        setTimeout(resolve, ms)
    );

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const rect =
      element.getBoundingClientRect();

    const style =
      window.getComputedStyle(
        element
      );

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  async function waitForElement(
    getElement,
    timeoutMs = 10000
  ) {
    const startedAt =
      Date.now();

    while (
      Date.now() - startedAt <
      timeoutMs
    ) {
      const element =
        getElement();

      if (element) {
        return element;
      }

      await sleep(250);
    }

    return null;
  }

  console.log(
    "[GOOGLE LISTING TEXT] Opening Search by image..."
  );

  const searchByImageButton =
    await waitForElement(
      () => {
        const direct =
          document.querySelector(
            '[aria-label="Search by image"]'
          );

        if (
          direct &&
          isVisible(direct)
        ) {
          return direct;
        }

        return (
          Array.from(
            document.querySelectorAll(
              'button, [role="button"]'
            )
          ).find(
            element => {
              const label =
                String(
                  element.getAttribute(
                    "aria-label"
                  ) || ""
                )
                  .trim()
                  .toLowerCase();

              return (
                isVisible(element) &&
                label.includes(
                  "search by image"
                )
              );
            }
          ) ||
          null
        );
      }
    );

  if (!searchByImageButton) {
    throw new Error(
      'Could not find "Search by image".'
    );
  }

  searchByImageButton.click();

  await sleep(700);

  /*
    Google's upload input can be hidden,
    so do NOT require it to be visible.
  */
  const fileInput =
    await waitForElement(
      () =>
        document.querySelector(
          'input[type="file"]'
        ),
      10000
    );

  if (!fileInput) {
    throw new Error(
      "Could not find Google's image upload input."
    );
  }

  /*
    Convert our Chrome screenshot data URL
    into a File that Google can accept.
  */
  const response =
    await fetch(
      dataUrl
    );

  const blob =
    await response.blob();

  const file =
    new File(
      [blob],
      "marketplace-listing-screenshot.png",
      {
        type:
          blob.type ||
          "image/png"
      }
    );

  const transfer =
    new DataTransfer();

  transfer.items.add(
    file
  );

  fileInput.files =
    transfer.files;

  fileInput.dispatchEvent(
    new Event(
      "change",
      {
        bubbles: true
      }
    )
  );

  console.log(
    "[GOOGLE LISTING TEXT] Screenshot uploaded."
  );

  return {
    submitted: true
  };
}

/*
  Process ONE Marketplace image.
*/

async function processSingleImage({
  imageUrl,
  imageIndex,
  totalImages,
  promptText = GOOGLE_LENS_PROMPT,
  cropObjectPath = ""
}) {
  console.log(
    `[DATAFORSEO] Processing image ${imageIndex}/${totalImages}`
  );


  const response =
    await fetch(
      `${MARKETPLACE_CONVERSATION_SERVER}/dataforseo-identify-image`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

     body:
  JSON.stringify({
    imageUrl,
    promptText,

    cropObjectPath:
      String(
        cropObjectPath ||
        ""
      ).trim()
  })
      }
    );


  let data;


  try {
    data =
      await response.json();

  } catch (error) {
    throw new Error(
      "DataForSEO server returned malformed JSON."
    );
  }


  if (
    !response.ok ||
    data?.ok !== true
  ) {
    throw new Error(
      data?.error ||
      "DataForSEO image identification failed."
    );
  }


  console.log(
    "[DATAFORSEO] Clean identification:",
    {
      imageIndex,

      found:
        data.found,

      identification:
        data.identification,

      confidence:
        data
          ?.cleanedEvidence
          ?.confidence,

      consensus:
        data
          ?.cleanedEvidence
          ?.consensus,

      taskId:
        data.dataForSeoTaskId,

      cost:
        data.dataForSeoCost
    }
  );


  /*
    IMPORTANT:

    Preserve the SAME basic response shape
    the existing Google-browser pipeline
    returned.

    The rest of background.js can continue
    operating normally.
  */
  return {
    imageIndex,

    imageUrl,

    prompt:
      promptText,

    aiOverviewFound:
      data.found === true,

    aiOverviewText:
      data.found === true
        ? String(
            data.identification ||
            ""
          ).trim()
        : "UNKNOWN",

    aiOverviewErrorCode:
      data.found === true
        ? ""
        : "DATAFORSEO_NO_CONFIDENT_IDENTIFICATION",

    /*
      New additional evidence.

      We will preserve this in the result object
      for Step 5.
    */
    dataForSeoEvidence:
      data.cleanedEvidence ||
      null,

    dataForSeoTaskId:
      String(
        data.dataForSeoTaskId ||
        ""
      ),

    dataForSeoCost:
      Number(
        data.dataForSeoCost ||
        0
      ),

    completedAt:
      new Date()
        .toISOString()
  };
}


chrome.runtime.onMessage.addListener(
  (
    message,
    sender,
    sendResponse
  ) => {
    if (
      message?.type !==
      "FETCH_LOCAL_SERVER"
    ) {
      return;
    }

    (
      async () => {
        const controller =
          new AbortController();

        const timeoutMs =
          Number(
            message.timeoutMs ||
            240000
          );

        const timeoutId =
          setTimeout(
            () => {
              controller.abort();
            },
            timeoutMs
          );

        try {
          const url =
            String(
              message.url || ""
            );

          /*
            Only allow this proxy to talk to
            our local Node server.
          */
          if (
            !url.startsWith(
              "http://127.0.0.1:3000/"
            ) &&
            !url.startsWith(
              "http://localhost:3000/"
            )
          ) {
            throw new Error(
              `Blocked non-local server URL: ${url}`
            );
          }

          const requestOptions =
            message.options || {};

          const fetchOptions = {
            method:
              requestOptions.method ||
              "GET",

            headers:
              requestOptions.headers ||
              {},

            signal:
              controller.signal
          };

          /*
            GET/HEAD requests must not have a body.
          */
          if (
            fetchOptions.method !== "GET" &&
            fetchOptions.method !== "HEAD" &&
            requestOptions.body != null
          ) {
            fetchOptions.body =
              requestOptions.body;
          }

          const response =
            await fetch(
              url,
              fetchOptions
            );

          const body =
            await response.text();

          sendResponse({
            ok: true,

            response: {
              ok:
                response.ok,

              status:
                response.status,

              statusText:
                response.statusText,

              headers:
                Array.from(
                  response.headers.entries()
                ),

              body
            }
          });

        } catch (error) {
          console.error(
            "[LOCAL SERVER PROXY] Fetch failed:",
            error
          );

          sendResponse({
            ok: false,

            error:
              error?.name ===
              "AbortError"
                ? (
                    `Local server request timed out after ` +
                    `${timeoutMs}ms.`
                  )
                : (
                    error?.message ||
                    String(error)
                  )
          });

        } finally {
          clearTimeout(
            timeoutId
          );
        }
      }
    )();

    /*
      CRITICAL.

      Keeps the Chrome message port alive while
      the asynchronous fetch is running.
    */
    return true;
  }
);

chrome.runtime.onMessage.addListener(
  (
    message,
    sender,
    sendResponse
  ) => {
    if (
      message.type ===
      "CAPTURE_VISIBLE_TAB"
    ) {
      chrome.tabs.captureVisibleTab(
        sender.tab.windowId,
        {
          format: "jpeg",
          quality: 75
        },
        dataUrl => {
          if (
            chrome.runtime.lastError
          ) {
            sendResponse({
              ok: false,
              error:
                chrome.runtime
                  .lastError
                  .message
            });

            return;
          }

          sendResponse({
            ok: true,
            screenshotDataUrl:
              dataUrl
          });
        }
      );

      return true;
    }

   if (
  message.type ===
  "OPEN_MARKETPLACE_LISTING_TAB"
) {
  const url =
    String(
      message.url ||
      ""
    ).trim();

  if (
    !/^https:\/\/www\.facebook\.com\/marketplace\/item\//i.test(
      url
    )
  ) {
    sendResponse({
      ok:
        false,

      error:
        "Invalid Marketplace listing URL."
    });

    return true;
  }


  chrome.tabs.create(
    {
      url,

      /*
        Make the listing visible while it is
        being analyzed.

        The browse tab remains immediately
        underneath it.
      */
      active:
        true,

      /*
        Keep it beside the browse tab.
      */
      index:
        sender.tab?.index != null
          ? sender.tab.index + 1
          : undefined
    },

    tab => {
      if (
        chrome.runtime.lastError
      ) {
        sendResponse({
          ok:
            false,

          error:
            chrome.runtime
              .lastError
              .message
        });

        return;
      }


      console.log(
        "[MARKETPLACE TAB] Opened listing tab:",
        {
          tabId:
            tab?.id,

          url
        }
      );


      sendResponse({
        ok:
          true,

        tabId:
          tab?.id ?? null
      });
    }
  );


  return true;
}

if (
  message.type ===
  "CLOSE_CURRENT_MARKETPLACE_LISTING_TAB"
) {
  const tabId =
    sender.tab?.id;

  if (
    !tabId
  ) {
    sendResponse({
      ok:
        false,

      error:
        "Could not determine current listing tab."
    });

    return true;
  }


  console.log(
    "[MARKETPLACE TAB] Closing completed listing tab:",
    tabId
  );


  /*
    Respond before removing the sender's own tab.
    Otherwise destroying the content script can
    close the message port before its callback runs.
  */
  sendResponse({
    ok:
      true,

    tabId
  });


  setTimeout(
    () => {
      chrome.tabs.remove(
        tabId
      ).catch(
        () => {}
      );
    },
    100
  );


  return true;
}

if (
  message.type ===
  "CLOSE_MARKETPLACE_AUTO_EBAY_TABS"
) {
      chrome.tabs.query(
        {},
        tabs => {
          const ebayTabs =
            tabs.filter(
              tab => {
                const url =
                  tab.url || "";

                return (
                  url.includes(
                    "ebay.com/sch/"
                  ) ||
                  url.includes(
                    "ebay.com/itm/"
                  ) ||
                  url.includes(
                    "ebay.com/p/"
                  )
                );
              }
            );

          const tabIds =
            ebayTabs
              .map(
                tab =>
                  tab.id
              )
              .filter(
                id =>
                  Number.isInteger(
                    id
                  )
              );

          if (
            !tabIds.length
          ) {
            sendResponse({
              ok: true,
              closed: 0
            });

            return;
          }

          chrome.tabs.remove(
            tabIds,
            () => {
              if (
                chrome.runtime
                  .lastError
              ) {
                sendResponse({
                  ok: false,
                  error:
                    chrome.runtime
                      .lastError
                      .message
                });

                return;
              }

              sendResponse({
                ok: true,
                closed:
                  tabIds.length
              });
            }
          );
        }
      );

      return true;
    }
  }
);

chrome.runtime.onMessage.addListener(
  (
    message,
    sender,
    sendResponse
  ) => {
    if (
      message?.type !==
      "PROCESS_SELECTED_GOOGLE_LENS_TARGETS"
    ) {
      return;
    }

    (
      async () => {
        try {
          const targets =
            Array.isArray(
              message.targets
            )
              ? message.targets
                  .map(
                    target => ({
                      galleryIndex:
                        Number(
                          target.galleryIndex
                        ) || 1,

                      productId:
                        String(
                          target.productId ||
                          ""
                        ).trim(),

                      productType:
                        String(
                          target.productType ||
                          ""
                        ).trim(),

                      bestImageIndex:
                        Number(
                          target.bestImageIndex
                        ),

                      modelReadabilityScore:
                        Number(
                          target.modelReadabilityScore
                        ) || 0,

                imageUrl:
  String(
    target.imageUrl ||
    ""
  ).trim(),

  cropPrepared:
  target.cropPrepared ===
  true,

dataForSeoImageUrl:
  String(
    target
      .dataForSeoImageUrl ||
    ""
  ).trim(),

dataForSeoCropObjectPath:
  String(
    target
      .dataForSeoCropObjectPath ||
    ""
  ).trim(),

cropBoundingBox:
  target.cropBoundingBox ||
  null,

cropError:
  String(
    target.cropError ||
    ""
  ).trim(),

sameTypeProductIds:
  Array.isArray(
    target.sameTypeProductIds
  )
    ? target.sameTypeProductIds
        .map(
          value =>
            String(
              value || ""
            ).trim()
        )
        .filter(Boolean)
    : [
        String(
          target.productId || ""
        ).trim()
      ]      
                        
                    })
                  )
                  .filter(
                    target =>
                      target.productId &&
                      target.productType &&
                      target.bestImageIndex >= 1 &&
                      target.imageUrl
                  )
              : [];

          if (!targets.length) {
            throw new Error(
              "No selected Google Lens targets were supplied."
            );
          }

         /*
  ------------------------------------------------------------
  GOOGLE IDENTIFICATION ORDER

  Targets whose selected image contains only ONE product
  of that same type go first.

  Examples:

  camera + lens:
    camera is unambiguous
    lens is unambiguous

  lens + lens:
    both lens targets are ambiguous

  camera + camera:
    both camera targets are ambiguous
  ------------------------------------------------------------
*/

targets.sort(
  (a, b) => {
    const aSameTypeCount =
      Array.isArray(
        a.sameTypeProductIds
      )
        ? a.sameTypeProductIds.length
        : 1;

    const bSameTypeCount =
      Array.isArray(
        b.sameTypeProductIds
      )
        ? b.sameTypeProductIds.length
        : 1;

    const aAmbiguous =
      aSameTypeCount > 1
        ? 1
        : 0;

    const bAmbiguous =
      bSameTypeCount > 1
        ? 1
        : 0;

    /*
      Unambiguous first.
    */
    if (
      aAmbiguous !==
      bAmbiguous
    ) {
      return (
        aAmbiguous -
        bAmbiguous
      );
    }

    /*
      Otherwise preserve chronological image order.
    */
    return (
      a.bestImageIndex -
      b.bestImageIndex
    );
  }
);

console.log(
  "[STEP 4] Ordered Google targets:",
  targets.map(
    target => ({
      productId:
        target.productId,

      productType:
        target.productType,

      image:
        target.bestImageIndex,

      sameTypeProductIds:
        target.sameTypeProductIds,

      ambiguous:
        target
          .sameTypeProductIds
          .length > 1
    })
  )
); 

          console.log(
            `[STEP 4] Starting Google Lens queue for ${targets.length} selected target(s).`
          );

/*
  Stores successfully identified models globally
  by PRODUCT TYPE rather than by gallery-local
  product IDs.

  Example:

    "camera body"
      → ["Canon EOS Rebel T5"]

    "camera lens"
      → ["Canon EF-S 18-55mm f/3.5-5.6 IS II"]
*/
/*
  Exact identities attached to physical gallery products.

  Key examples:

    "1::lens_1"
    "1::camera_1"
    "2::lens_1"

  Gallery index is included because product IDs are
  only guaranteed to be unique within one gallery.
*/
const identifiedModelsByProduct =
  new Map();


function makePhysicalProductKey(
  galleryIndex,
  productId
) {
  return [
    Number(galleryIndex) || 1,
    String(productId || "").trim()
  ].join("::");
}


function getIdentifiedModelForProduct(
  galleryIndex,
  productId
) {
  return (
    identifiedModelsByProduct.get(
      makePhysicalProductKey(
        galleryIndex,
        productId
      )
    ) ||
    null
  );
}


function saveIdentifiedModelForProduct(
  galleryIndex,
  productId,
  model
) {
  const cleanModel =
    String(
      model || ""
    ).trim();

  if (!cleanModel) {
    return;
  }

  const key =
    makePhysicalProductKey(
      galleryIndex,
      productId
    );

  identifiedModelsByProduct.set(
    key,
    cleanModel
  );

  console.log(
    "[STEP 4] Physical product identity updated:",
    {
      key,
      model:
        cleanModel
    }
  );
}


/*
  Prevent an ambiguous image containing multiple
  same-type products from being sent to Google more
  than necessary.

  Example:

    Image 8 contains:
      lens_1
      lens_2

  Once Image 8 has been used to identify the one
  remaining unknown lens, do not run Image 8 again
  for the second gallery-local lens ID.
*/
const processedAmbiguousGroups =
  new Set();


function getProductTypeKey(
  productType
) {
  return getGoogleProductLabel(
    productType
  )
    .trim()
    .toLowerCase();
}


function makeAmbiguousGroupKey(
  target
) {
  return [
    getProductTypeKey(
      target.productType
    ),
    target.bestImageIndex,
    target.imageUrl
  ].join("::");
}

          const results = [];

          await chrome.storage.local.set({
            marketplaceGoogleLensRunStatus: {
              running: true,
              totalTargets:
                targets.length,
              currentTarget: 0,
              startedAt:
                new Date().toISOString()
            },

            marketplaceGoogleLensResults:
              []
          });

          for (
            let index = 0;
            index < targets.length;
            index++
          ) {
            const target =
              targets[index];

            await chrome.storage.local.set({
              marketplaceGoogleLensRunStatus: {
                running: true,
                totalTargets:
                  targets.length,
                currentTarget:
                  index + 1,
                startedAt:
                  (
                    await chrome.storage.local.get(
                      "marketplaceGoogleLensRunStatus"
                    )
                  )
                    .marketplaceGoogleLensRunStatus
                    ?.startedAt ||
                  new Date().toISOString()
              }
            });

/*
  How many products of THIS SAME TYPE does Luna say
  are visible in the selected image?

  camera + lens:
    camera count = 1
    lens count   = 1

  lens + lens:
    lens count   = 2
*/
const sameTypeProductIds =
  Array.isArray(
    target.sameTypeProductIds
  )
    ? target.sameTypeProductIds
    : [
        target.productId
      ];

const sameTypeCount =
  Math.max(
    1,
    sameTypeProductIds.length
  );


/*
  Every model of this type that Google has already
  successfully identified earlier in the listing.
*/
/*
  ONLY consider identities belonging to same-type
  physical products actually visible in THIS image.

  Do not use unrelated lenses/cameras identified
  elsewhere in the listing.
*/
const knownModels =
  sameTypeProductIds
    .map(
      productId =>
        getIdentifiedModelForProduct(
          target.galleryIndex,
          productId
        )
    )
    .filter(Boolean);


const isAmbiguous =
  sameTypeCount > 1;


/*
  Normal images can run immediately.

  An ambiguous image can run ONLY if there is exactly
  one unidentified product of that type remaining.

  Example:

    Image 8 has 2 lenses
    Known lenses = 1

    2 - 1 = 1 remaining
    → safe to ask Google for "the other lens"

  But:

    Image has 3 lenses
    Known lenses = 1

    3 - 1 = 2 remaining
    → still ambiguous, so do NOT guess.
*/
const remainingUnknownCount =
  Math.max(
    0,
    sameTypeCount -
      knownModels.length
  );


/*
  Three modes:

  SINGLE
    Only one product of this type is visible.

  EXCLUSION
    Multiple products are visible, but exactly one
    remains unidentified.

  GROUP
    Multiple products are visible and two or more
    remain unidentified.
*/
let identificationMode =
  "single";

if (
  isAmbiguous &&
  remainingUnknownCount === 1
) {
  identificationMode =
    "exclusion";

} else if (
  isAmbiguous &&
  remainingUnknownCount > 1
) {
  identificationMode =
    "group";
}


/*
  For ambiguous images we use every known model of
  this type as an exclusion.
*/
const excludedModels =
  isAmbiguous
    ? [...knownModels]
    : [];


const ambiguousGroupKey =
  makeAmbiguousGroupKey(
    target
  );


/*
  Image 8 may have generated both lens_1 and lens_2
  targets.

  Once we've used Image 8 once to identify the one
  remaining unknown lens, the second target should
  NOT cause another Google call.
*/
if (
  isAmbiguous &&
  processedAmbiguousGroups.has(
    ambiguousGroupKey
  )
) {
  console.log(
    "[STEP 4] Skipping duplicate ambiguous image target:",
    {
      productId:
        target.productId,

      image:
        target.bestImageIndex,

      productType:
        target.productType
    }
  );

  continue;
}


let promptText = null;


/*
  Normal singular request.
*/
if (
  identificationMode ===
  "single"
) {
  promptText =
    buildGoogleLensPromptForTarget({
      productType:
        target.productType,

      excludedModels: []
    });
}


/*
  Multiple same-type products are visible,
  but every one except this product has
  already been identified.
*/
else if (
  identificationMode ===
  "exclusion"
) {
  promptText =
    buildGoogleLensPromptForTarget({
      productType:
        target.productType,

      excludedModels:
        [...knownModels]
    });
}


/*
  Multiple unknown same-type products remain.

  Ask Google for ALL remaining models instead
  of abandoning the image.
*/
else {
  promptText =
    buildGoogleLensPromptForGroup({
      productType:
        target.productType,

      expectedCount:
        remainingUnknownCount,

      excludedModels:
        [...knownModels]
    });
}

let result;

try {
    console.log(
      "[STEP 4] Google identification target:",
      {
        productId:
          target.productId,

        image:
          target.bestImageIndex,

        excludedModels,

        prompt:
          promptText
      }
    );

    const dataForSeoImageUrl =
  String(
    target
      ?.dataForSeoImageUrl ||
    ""
  ).trim();


if (!dataForSeoImageUrl) {
  throw new Error(
    target?.cropError ||
    `No isolated DataForSEO crop was prepared for ${target.productId}.`
  );
}


console.log(
  "[DATAFORSEO CROP] Using isolated crop:",
  {
    productId:
      target.productId,

    originalImage:
      target.imageUrl,

    cropImage:
      dataForSeoImageUrl,

    boundingBox:
      target.cropBoundingBox
  }
);


const baseResult =
  await processSingleImage({
    imageUrl:
      dataForSeoImageUrl,

    imageIndex:
      target.bestImageIndex,

    totalImages:
      targets.length,

    promptText,

    cropObjectPath:
      target
        .dataForSeoCropObjectPath
  });

      console.log(
  "[DEBUG STEP 4A] Raw processSingleImage result:",
  {
    galleryIndex:
      target.galleryIndex,

    productId:
      target.productId,

    productType:
      target.productType,

    imageIndex:
      target.bestImageIndex,

      dataForSeoEvidence:
  baseResult
    .dataForSeoEvidence ||
  null,

dataForSeoTaskId:
  baseResult
    .dataForSeoTaskId ||
  "",

dataForSeoCost:
  Number(
    baseResult
      .dataForSeoCost ||
    0
  ),

    identificationMode,

    promptText,

    aiOverviewFound:
      baseResult
        ?.aiOverviewFound,

    aiOverviewText:
      baseResult
        ?.aiOverviewText,

    aiOverviewErrorCode:
      baseResult
        ?.aiOverviewErrorCode,

    completedAt:
      baseResult
        ?.completedAt
  }
);


    /*
      Convert Google's result into either:
        "Canon EF-S 18-55mm f/3.5-5.6 IS II"

      or:
        null
    */
let identifiedModel =
  null;

let groupIdentificationText =
  null;


if (
  identificationMode ===
  "group"
) {
  /*
    Preserve Google's complete plural answer.

    Step 5 will reconcile these model names against
    the physical products visible in this exact image.
  */
  groupIdentificationText =
    cleanGoogleLensAiText(
      baseResult.aiOverviewText
    );

} else {
  identifiedModel =
    cleanGoogleIdentificationResult(
      baseResult.aiOverviewText
    );
}

console.log(
  "[DEBUG STEP 4B] Google identification cleanup:",
  {
    productId:
      target.productId,

    productType:
      target.productType,

    identificationMode,

    rawText:
      baseResult
        ?.aiOverviewText,

    identifiedModel,

    groupIdentificationText,

    rawFound:
      baseResult
        ?.aiOverviewFound ===
        true
  }
);


    /*
      Save successful identity so later ambiguous
      images can exclude it.
    */
/*
  Store this successful identity globally by type.

  Gallery-local product IDs no longer matter here.
*/
if (
  identifiedModel
) {
  saveIdentifiedModelForProduct(
    target.galleryIndex,
    target.productId,
    identifiedModel
  );
}

console.log(
  "[DEBUG STEP 4C] Physical identity state after save:",
  {
    galleryIndex:
      target.galleryIndex,

      dataForSeoEvidence:
  baseResult
    .dataForSeoEvidence ||
  null,

dataForSeoTaskId:
  baseResult
    .dataForSeoTaskId ||
  "",

dataForSeoCost:
  Number(
    baseResult
      .dataForSeoCost ||
    0
  ),

    productId:
      target.productId,

    attemptedModel:
      identifiedModel,

    storedModel:
      getIdentifiedModelForProduct(
        target.galleryIndex,
        target.productId
      ),

    knownModelsForVisibleProducts:
      sameTypeProductIds.map(
        productId => ({
          productId,

          model:
            getIdentifiedModelForProduct(
              target.galleryIndex,
              productId
            )
        })
      )
  }
);

/*
  If this was an ambiguous image, one Google call has
  now handled the single remaining unknown product.

  Prevent another target from the same image/type
  from causing a duplicate Google search.
*/
const hasUsableGoogleResult =
  baseResult.aiOverviewFound === true &&
  String(
    baseResult.aiOverviewText || ""
  ).trim().length > 0;

if (
  isAmbiguous &&
  hasUsableGoogleResult
) {
  processedAmbiguousGroups.add(
    ambiguousGroupKey
  );
}


    result = {
      galleryIndex:
        target.galleryIndex,

        dataForSeoEvidence:
  baseResult
    .dataForSeoEvidence ||
  null,

dataForSeoTaskId:
  baseResult
    .dataForSeoTaskId ||
  "",

dataForSeoCost:
  Number(
    baseResult
      .dataForSeoCost ||
    0
  ),

      targetProductId:
        target.productId,

      targetProductType:
        target.productType,

      targetImageIndex:
        target.bestImageIndex,

      targetModelReadabilityScore:
        target.modelReadabilityScore,

      imageUrl:
        target.imageUrl,

      prompt:
        promptText,

      aiOverviewFound:
        baseResult.aiOverviewFound,

      aiOverviewText:
        baseResult.aiOverviewText,

      /*
        NEW CLEAN VALUE
      */
     identifiedModel,

identificationMode,

sameTypeProductIds:
  [...sameTypeProductIds],

sameTypeCount,

remainingUnknownCount,

groupIdentificationText,

ambiguityResolved:
  identificationMode !== "group",

excludedModels:
  [...knownModels],

      completedAt:
        baseResult.completedAt
    };

} catch (error) {


 console.error(
  "[DEBUG STEP 4 ERROR] DataForSEO identification threw an exception:",
  {
    galleryIndex:
      target.galleryIndex,

    productId:
      target.productId,

    productType:
      target.productType,

    imageIndex:
      target.bestImageIndex,

    identificationMode,

    promptText,

    errorMessage:
      error?.message ||
      String(error),

    stack:
      error?.stack ||
      ""
  }
);
  
  /*
    Failed Google identification.

    Do not add null to identifiedModelsByType because
    only successful identities should become future
    exclusions.
  */


result = {
  galleryIndex:
    target.galleryIndex,

  targetProductId:
    target.productId,

  targetProductType:
    target.productType,

  targetImageIndex:
    target.bestImageIndex,

  targetModelReadabilityScore:
    target.modelReadabilityScore,

  imageUrl:
    target.imageUrl,

  prompt:
    promptText,

  aiOverviewFound:
    false,

  aiOverviewText:
    "",

  identifiedModel:
    null,

  dataForSeoEvidence:
    null,

  dataForSeoTaskId:
    "",

  dataForSeoCost:
    0,

  ambiguityResolved:
    identificationMode !== "group",

  excludedModels,

  error:
    error?.message ||
    String(error),

  completedAt:
    new Date()
      .toISOString()
};
}

console.log(
  "[DEBUG STEP 4D] Final Step 4 result object BEFORE storage:",
  JSON.parse(
    JSON.stringify(
      result
    )
  )
);

            results.push(
              result
            );

            await chrome.storage.local.set({
              marketplaceGoogleLensResults:
                results
            });

            const debugStoredGoogleResults =
  await chrome.storage.local.get(
    "marketplaceGoogleLensResults"
  );

console.log(
  "[DEBUG STEP 4E] Google results AFTER storage:",
  JSON.parse(
    JSON.stringify(
      debugStoredGoogleResults
        .marketplaceGoogleLensResults ||
      []
    )
  )
);

            console.log(
              `[STEP 4] Saved Google result ${index + 1}/${targets.length}.`
            );

            await sleep(
              1500
            );
          }

          await chrome.storage.local.set({
            marketplaceGoogleLensResults:
              results,

            marketplaceGoogleLensRunStatus: {
              running: false,
              totalTargets:
                targets.length,
              currentTarget:
                targets.length,
              finishedAt:
                new Date().toISOString()
            }
          });

          sendResponse({
            ok: true,
            results
          });

        } catch (error) {
          console.error(
            "[STEP 4] Selected Google Lens pipeline failed:",
            error
          );

          await chrome.storage.local.set({
            marketplaceGoogleLensRunStatus: {
              running: false,
              error:
                error?.message ||
                String(error),
              finishedAt:
                new Date().toISOString()
            }
          });

          sendResponse({
            ok: false,
            error:
              error?.message ||
              String(error)
          });
        }
      }
    )();

    return true;
  }
);