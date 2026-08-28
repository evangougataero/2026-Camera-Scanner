const GOOGLE_LENS_PROMPT =
  "Identify the camera(s) and lens(es) in this image if present. Simply list their full model names and don't provide any more information. If the camera or lens is too unclear to accurately identify, say so clearly instead of guessing.";

const LOCAL_SERVER_BASE_URL =
  "http://127.0.0.1:3000";

const REMOTE_WORKER_ALARM =
  "remote-browser-worker-poll";

/*
  Check approximately every 30 seconds for a job.
*/
const REMOTE_WORKER_POLL_MINUTES =
  0.5;

let processingJob =
  false;

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

  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    const fullPageText =
      String(
        document.body?.innerText ||
        ""
      );

    const lowerPageText =
      fullPageText.toLowerCase();

    /*
      Detect Google verification / blocking pages.
    */
    if (
      lowerPageText.includes(
        "our systems have detected unusual traffic"
      ) ||
      lowerPageText.includes(
        "i'm not a robot"
      ) ||
      lowerPageText.includes(
        "verify you're human"
      ) ||
      lowerPageText.includes(
        "verify you are human"
      )
    ) {
      return {
        found: false,
        code:
          "GOOGLE_CHALLENGE",
        text:
          "Google displayed a human-verification or unusual-traffic page."
      };
    }

    /*
      We deliberately scrape the ENTIRE visible page.

      Then we snip out only the text between:

        AI Overview

      and:

        AI responses may include mistakes.
    */
    const startMarker =
      "AI Overview";

    const endMarker =
      "AI responses may include mistakes.";

    const startIndex =
      fullPageText.indexOf(
        startMarker
      );

    if (
      startIndex !== -1
    ) {
      const answerStart =
        startIndex +
        startMarker.length;

      const endIndex =
        fullPageText.indexOf(
          endMarker,
          answerStart
        );

      /*
        Only accept the answer once Google's normal
        end marker has appeared.

        This also prevents us from grabbing the AI
        response while it is still being generated.
      */
      if (
        endIndex !== -1
      ) {
        const extractedText =
          fullPageText
            .slice(
              answerStart,
              endIndex
            )
            .trim();

        console.log(
          "[GOOGLE FULL PAGE EXTRACTION] Full page text length:",
          fullPageText.length
        );

        console.log(
          "[GOOGLE FULL PAGE EXTRACTION] Extracted AI text:",
          extractedText
        );

        if (
          extractedText
        ) {
          return {
            found: true,
            code:
              "GOOGLE_AI_TEXT_EXTRACTED",
            text:
              extractedText
          };
        }
      }
    }

    await sleep(
      500
    );
  }

  /*
    Diagnostic information if extraction fails.
  */
  const finalPageText =
    String(
      document.body?.innerText ||
      ""
    );

  console.warn(
    "[GOOGLE FULL PAGE EXTRACTION] Timed out.",
    {
      pageTextLength:
        finalPageText.length,

      hasAiOverview:
        finalPageText.includes(
          "AI Overview"
        ),

      hasEndMarker:
        finalPageText.includes(
          "AI responses may include mistakes."
        ),

      first2000Characters:
        finalPageText.slice(
          0,
          2000
        )
    }
  );

  return {
    found: false,
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
  promptText = GOOGLE_LENS_PROMPT
}) {
  console.log(
    `[GOOGLE LENS TEST] Processing image ${imageIndex}/${totalImages}`
  );


  /*
    Open a NORMAL ACTIVE tab.

    The user will actually see Google.
  */
  const googleTab =
    await chrome.tabs.create({
      url:
        "https://www.google.com/search?udm=49&udf=257",

      active: true
    });


  if (!googleTab?.id) {
    throw new Error(
      "Could not create Google tab."
    );
  }


let tabId =
  googleTab.id;


  try {
    /*
      -------------------------
      STEP 1 — IMAGE SEARCH
      -------------------------
    */
   
const initialTab =
  await waitForTabComplete(
    tabId,
    30000
  );

await sleep(750);

const initialGoogleUrl =
  String(
    initialTab?.url || ""
  ).trim();


const isDataUrl =
  String(
    imageUrl || ""
  ).startsWith(
    "data:image/"
  );

console.log(
  isDataUrl
    ? `[GOOGLE LENS TEST] Image ${imageIndex}: uploading screenshot.`
    : `[GOOGLE LENS TEST] Image ${imageIndex}: submitting image URL.`
);


await chrome.scripting
  .executeScript({
    target: {
      tabId
    },

    func:
      isDataUrl
        ? submitDataUrlImageToGoogle
        : submitImageToGoogle,

    args: [
      imageUrl
    ]
  });


/*
  Do NOT proceed merely because Chrome says
  the tab is complete.

  Wait until Google has actually generated
  a Lens image-search session.
*/
const lensSessionUrl =
  await waitForGoogleLensImageSession(
    tabId,
    initialGoogleUrl,
    35000
  );

console.log(
  `[GOOGLE LENS TEST] Image ${imageIndex}: Lens image session ready:`,
  lensSessionUrl
);


/*
  -------------------------
  STEP 2 — TEXT QUERY
  -------------------------
*/
console.log(
  `[GOOGLE LENS TEST] Image ${imageIndex}: navigating existing Lens tab to text-query URL.`
);


/*
  Convert the existing image-only Lens session
  into the final image + text query in the SAME tab.
*/
const multimodalUrl =
  await navigateLensWithTextPrompt(
    tabId,
    promptText
  );


console.log(
  "[GOOGLE LENS TEST] Existing tab navigated to multimodal result:",
  {
    imageIndex,
    tabId,
    multimodalUrl
  }
);


/*
  Small rendering grace period.


/*
  Small rendering grace period.

  The document may be loaded before Google has
  rendered the AI Overview contents.
*/
await sleep(
  1500
);

    /*
      -------------------------
      STEP 3 — EXTRACT AI
      -------------------------
    */
    console.log(
      `[GOOGLE LENS TEST] Image ${imageIndex}: waiting for AI Overview.`
    );


    const extraction =
      await chrome.scripting
        .executeScript({
          target: {
            tabId
          },

          func:
            extractAiOverview
        });


    const extractedResult =
      extraction?.[0]?.result ||
      {
        found: false,
        text:
          "No extraction result returned."
      };


    console.log(
      `[GOOGLE LENS TEST] Image ${imageIndex} AI Overview:`
    );


    console.log(
      extractedResult.text
    );


    return {
      imageIndex,

      imageUrl,

 prompt:
  promptText,

      aiOverviewFound:
        extractedResult.found ===
        true,

aiOverviewText:
  cleanGoogleLensAiText(
    extractedResult.text
  ),

aiOverviewErrorCode:
  String(
    extractedResult.code ||
    ""
  ),

      completedAt:
        new Date()
          .toISOString()
    };

  } finally {
    /*
      Close this Lens tab no matter whether
      extraction succeeds or fails.

      Short pause lets you visually see the
      completed result before Chrome closes it.
    */
    await sleep(
      1200
    );


    try {
      await chrome.tabs.remove(
        tabId
      );

      console.log(
        `[GOOGLE LENS TEST] Closed Google tab for image ${imageIndex}.`
      );

    } catch (error) {
      console.warn(
        "[GOOGLE LENS TEST] Could not close Google tab:",
        error
      );
    }
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

async function claimNextGoogleLensJob() {
  const data =
    await fetchJson(
      "/google-lens-worker/jobs/claim",
      {
        method:
          "POST",

        body:
          JSON.stringify({})
      }
    );

  return (
    data?.job ||
    null
  );
}


async function completeGoogleLensJob(
  jobId,
  results
) {
  return fetchJson(
    `/google-lens-worker/jobs/${encodeURIComponent(jobId)}/complete`,
    {
      method:
        "POST",

      body:
        JSON.stringify({
          results
        })
    }
  );
}


async function failGoogleLensJob(
  jobId,
  error
) {
  try {
    await fetchJson(
      `/google-lens-worker/jobs/${encodeURIComponent(jobId)}/fail`,
      {
        method:
          "POST",

        body:
          JSON.stringify({
            error:
              error?.message ||
              String(error)
        })
      }
    );

  } catch (reportError) {
    console.error(
      "[GOOGLE LENS WORKER] Could not report failure:",
      reportError
    );
  }
}

async function processGoogleLensTargets(
  suppliedTargets
) {
  const targets =
    Array.isArray(
      suppliedTargets
    )
      ? suppliedTargets
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
                        target.productId ||
                        ""
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

          for (
            let index = 0;
            index < targets.length;
            index++
          ) {
            const target =
              targets[index];

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

    const baseResult =
      await processSingleImage({
        imageUrl:
          target.imageUrl,

        imageIndex:
          target.bestImageIndex,

        totalImages:
          targets.length,

        promptText
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
  "[DEBUG STEP 4 ERROR] Google identification threw an exception:",
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

            console.log(
              `[STEP 4] Saved Google result ${index + 1}/${targets.length}.`
            );

            await sleep(
              1500
            );
          }

  return results;
}

async function processGoogleLensJob(
  job
) {
  const jobId =
    String(
      job?.jobId ||
      ""
    ).trim();

  const targets =
    Array.isArray(
      job?.targets
    )
      ? job.targets
      : [];

  if (
    !jobId ||
    !targets.length
  ) {
    throw new Error(
      "Google Lens worker job is missing jobId or targets."
    );
  }

  console.log(
    "[GOOGLE LENS WORKER] Processing:",
    {
      jobId,

      targetCount:
        targets.length
    }
  );

  try {
    const results =
      await processGoogleLensTargets(
        targets
      );

    await completeGoogleLensJob(
      jobId,
      results
    );

    console.log(
      "[GOOGLE LENS WORKER] Job complete:",
      {
        jobId,

        resultCount:
          results.length
      }
    );

  } catch (error) {
    console.error(
      "[GOOGLE LENS WORKER] Job failed:",
      error
    );

    await failGoogleLensJob(
      jobId,
      error
    );
  }
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


async function fetchJson(
  path,
  options = {}
) {
  const response =
    await fetch(
      `${LOCAL_SERVER_BASE_URL}${path}`,
      {
        cache:
          "no-store",

        ...options,

        headers: {
          "Content-Type":
            "application/json",

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data = {};

  if (text) {
    try {
      data =
        JSON.parse(
          text
        );

    } catch (error) {
      throw new Error(
        `Server returned invalid JSON: ${text.slice(0, 500)}`
      );
    }
  }

  if (
    !response.ok ||
    data?.ok === false
  ) {
    throw new Error(
      data?.error ||
      `Server request failed with HTTP ${response.status}`
    );
  }

  return data;
}


/*
  ============================================================
  WAIT FOR EBAY TAB
  ============================================================
*/

async function waitForTabComplete(
  tabId,
  timeoutMs = 30000
) {
  const startedAt =
    Date.now();

  while (
    Date.now() -
      startedAt <
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
  "Worker tab was closed."
);
    }

    if (
      tab?.status ===
      "complete"
    ) {
      /*
        Give eBay a little more time to render
        the actual results.
      */
      await sleep(
        1200
      );

      return true;
    }

    await sleep(
      250
    );
  }

  throw new Error(
  "Timed out waiting for worker page."
);
}


/*
  ============================================================
  CLAIM NEXT JOB
  ============================================================
*/

async function claimNextEbayJob() {
  const data =
    await fetchJson(
      "/ebay-worker/jobs/claim",
      {
        method:
          "POST",

        body:
          JSON.stringify({})
      }
    );

  return (
    data?.job ||
    null
  );
}


/*
  ============================================================
  SEND COMPLETED RESULTS
  ============================================================
*/

async function completeEbayJob(
  jobId,
  listings
) {
  return fetchJson(
    `/ebay-worker/jobs/${encodeURIComponent(jobId)}/complete`,
    {
      method:
        "POST",

      body:
        JSON.stringify({
          listings
        })
    }
  );
}


/*
  ============================================================
  REPORT FAILURE
  ============================================================
*/

async function failEbayJob(
  jobId,
  error
) {
  try {
    await fetchJson(
      `/ebay-worker/jobs/${encodeURIComponent(jobId)}/fail`,
      {
        method:
          "POST",

        body:
          JSON.stringify({
            error:
              error?.message ||
              String(error)
        })
      }
    );

  } catch (reportError) {
    console.error(
      "[EBAY WORKER] Could not report failure:",
      reportError
    );
  }
}


/*
  ============================================================
  ASK CONTENT.JS TO SCRAPE THE EBAY PAGE
  ============================================================
*/

async function scrapeEbayTab(
  tabId
) {
  const startedAt =
    Date.now();

  let lastError =
    null;

  /*
    Keep trying briefly because content.js may not
    be ready immediately after the tab loads.
  */
  while (
    Date.now() -
      startedAt <
    15000
  ) {
    try {
      const result =
        await chrome.tabs.sendMessage(
          tabId,
          {
            type:
              "SCRAPE_EBAY_RESULTS"
          }
        );

      if (
        result?.ok === true
      ) {
        return result;
      }

      lastError =
        new Error(
          result?.error ||
          "eBay scraper returned failure."
        );

    } catch (error) {
      lastError =
        error;
    }

    await sleep(
      500
    );
  }

  throw new Error(
    lastError?.message ||
    "Could not communicate with eBay content script."
  );
}


/*
  ============================================================
  PROCESS ONE CLAIMED JOB
  ============================================================
*/

async function processEbayJob(
  job
) {
  const jobId =
    String(
      job?.jobId ||
      ""
    ).trim();

  const ebayUrl =
    String(
      job?.ebayUrl ||
      ""
    ).trim();

  if (
    !jobId ||
    !ebayUrl
  ) {
    throw new Error(
      "Worker job is missing jobId or ebayUrl."
    );
  }

  console.log(
    "[EBAY WORKER] Processing:",
    {
      jobId,
      ebayUrl
    }
  );

  let tabId =
    null;

  try {
    /*
      IMPORTANT:

      Use the EXACT URL supplied by the main extension.

      Do not rebuild the eBay query here.
    */
    const tab =
      await chrome.tabs.create({
        url:
          ebayUrl,

        active:
          false
      });

    if (!tab?.id) {
      throw new Error(
        "Could not create eBay worker tab."
      );
    }

    tabId =
      tab.id;


    await waitForTabComplete(
      tabId
    );


    const result =
      await scrapeEbayTab(
        tabId
      );


    const listings =
      Array.isArray(
        result.listings
      )
        ? result.listings
        : [];


    console.log(
      "[EBAY WORKER] Scraped:",
      listings.length,
      "listings"
    );


    /*
      Return RAW eBay listings.

      The main server still does:
      - AI cleanup
      - median price
      - pollution detection
      - resale estimate
      - final decision
    */
    await completeEbayJob(
      jobId,
      listings
    );


    console.log(
      "[EBAY WORKER] Job complete:",
      jobId
    );

  } catch (error) {
    console.error(
      "[EBAY WORKER] Job failed:",
      error
    );

    await failEbayJob(
      jobId,
      error
    );

  } finally {
    /*
      Always close worker tab afterward.
    */
    if (
      Number.isInteger(
        tabId
      )
    ) {
      try {
        await chrome.tabs.remove(
          tabId
        );

      } catch (error) {
        // already closed
      }
    }
  }
}


/*
  ============================================================
  CHECK SERVER FOR WORK
  ============================================================
*/

async function checkForRemoteJob() {
  if (
    processingJob
  ) {
    return;
  }

  processingJob =
    true;

  try {
    /*
      First check eBay.
    */
    let ebayJob =
      null;

    try {
      ebayJob =
        await claimNextEbayJob();

    } catch (error) {
      console.warn(
        "[REMOTE WORKER] Could not check eBay queue:",
        error?.message ||
        error
      );
    }

    if (ebayJob) {
      await processEbayJob(
        ebayJob
      );

      return;
    }


    /*
      No eBay job.
      Check Google Lens.
    */
    let googleJob =
      null;

    try {
      googleJob =
        await claimNextGoogleLensJob();

    } catch (error) {
      console.warn(
        "[REMOTE WORKER] Could not check Google Lens queue:",
        error?.message ||
        error
      );
    }

    if (googleJob) {
      await processGoogleLensJob(
        googleJob
      );

      return;
    }


    console.log(
      "[REMOTE WORKER] No pending jobs."
    );

  } finally {
    processingJob =
      false;
  }
}


/*
  ============================================================
  POLLING ALARM
  ============================================================
*/

async function ensureWorkerAlarm() {
  const existing =
    await chrome.alarms.get(
      REMOTE_WORKER_ALARM
    );

  if (existing) {
    return;
  }

  chrome.alarms.create(
    REMOTE_WORKER_ALARM,
    {
      /*
        First check shortly after extension loads.
      */
      delayInMinutes:
        0.05,

      /*
        Then roughly every 30 seconds.
      */
      periodInMinutes:
        REMOTE_WORKER_POLL_MINUTES
    }
  );

  console.log(
    "[REMOTE WORKER] Poll alarm created."
  );
}


chrome.alarms.onAlarm.addListener(
  alarm => {
    if (
      alarm.name !==
      REMOTE_WORKER_ALARM
    ) {
      return;
    }

   checkForRemoteJob()
  .catch(
    error => {
      console.error(
        "[REMOTE WORKER] Poll failed:",
        error
      );
    }
  );
  }
);


chrome.runtime.onStartup.addListener(
  () => {
    void ensureWorkerAlarm();
    void checkForRemoteJob();
  }
);


chrome.runtime.onInstalled.addListener(
  () => {
    void ensureWorkerAlarm();
    void checkForRemoteJob();
  }
);


/*
  Ensure it also gets created after manually
  reloading the extension from chrome://extensions.
*/
void ensureWorkerAlarm();