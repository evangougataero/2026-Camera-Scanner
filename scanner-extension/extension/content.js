console.log("eBay AI Comp Checker loaded on:", window.location.href);

/*
  ============================================================
  EBAY TESTING MODE
  ============================================================

  false = NORMAL SCANNER
    - use global Supabase product resale database
    - database misses use ACTIVE eBay listings only
    - estimate resale from active-listing P15
    - save new estimates back to global product database
    - do NOT write ebay_active_training_data

  true = TRAINING MODE
    - disable global product database lookup
    - disable global product database writes
    - use old SOLD eBay workflow
    - server also collects ACTIVE listings
    - write sold + active observations to
      ebay_active_training_data
*/
const TESTING_MODE = false;

const MAX_CONCURRENT_MARKETPLACE_ANALYSES =
  2;

const MARKETPLACE_ANALYSIS_JOBS_KEY =
  "marketplaceAnalysisJobs";

const MARKETPLACE_FINISH_LOCK_KEY =
  "marketplaceAnalysisFinishLock";

  const MARKETPLACE_ANALYSIS_JOB_PREFIX =
  "marketplaceAnalysisJob:";

const MARKETPLACE_BACKGROUND_JOB_STATUSES =
  new Set([
    "waiting-dataforseo",
    "resume-ready",
    "finishing"
  ]);

const MARKETPLACE_JOB_STALE_MS = {
  analyzing: 4 * 60 * 1000,
  "waiting-dataforseo": 12 * 60 * 1000,
  "resume-ready": 2 * 60 * 1000,
  finishing: 6 * 60 * 1000
};

const MARKETPLACE_DEFAULT_JOB_STALE_MS =
  4 * 60 * 1000;

const MARKETPLACE_ORPHAN_GRACE_MS =
  90 * 1000;


function getMarketplaceAnalysisJobStorageKey(
  jobId
) {
  return (
    MARKETPLACE_ANALYSIS_JOB_PREFIX +
    String(jobId || "")
  );
}


function isMarketplaceAnalysisJobTerminal(
  job
) {
  return [
    "complete",
    "failed"
  ].includes(
    String(
      job?.status || ""
    )
  );
}


function isMarketplaceBackgroundAnalysisJob(
  job
) {
  return MARKETPLACE_BACKGROUND_JOB_STATUSES.has(
    String(
      job?.status || ""
    )
  );
}


function getMarketplaceAnalysisJobLastActivityAt(
  job
) {
  return Math.max(
    Number(job?.updatedAt || 0),
    Number(job?.dataForSeoReturnedAt || 0),
    Number(job?.parkedAt || 0),
    Number(job?.startedAt || 0),
    Number(job?.createdAt || 0)
  );
}


function isMarketplaceAnalysisJobStale(
  job,
  now = Date.now()
) {
  if (
    !job ||
    isMarketplaceAnalysisJobTerminal(job)
  ) {
    return false;
  }

  const lastActivityAt =
    getMarketplaceAnalysisJobLastActivityAt(
      job
    );

  if (!lastActivityAt) {
    return true;
  }

  const status =
    String(
      job?.status || ""
    );

  const staleAfterMs =
    MARKETPLACE_JOB_STALE_MS[
      status
    ] ||
    MARKETPLACE_DEFAULT_JOB_STALE_MS;

  return (
    now - lastActivityAt >=
    staleAfterMs
  );
}

async function getMarketplaceAnalysisJobs() {
  const stored =
    await chrome.storage.local.get(
      null
    );

  return Object.entries(
    stored
  )
    .filter(
      ([key, value]) =>
        key.startsWith(
          MARKETPLACE_ANALYSIS_JOB_PREFIX
        ) &&
        value?.jobId
    )
    .map(
      ([, value]) =>
        value
    );
}


function getCurrentMarketplaceAnalysisJobId() {
  const listingId =
    getFacebookMarketplaceItemId(
      window.location.href
    );

  return listingId
    ? `listing-${listingId}`
    : null;
}


async function getMarketplaceAnalysisJobById(
  jobId
) {
  if (!jobId) {
    return null;
  }

  const key =
    getMarketplaceAnalysisJobStorageKey(
      jobId
    );

  const stored =
    await chrome.storage.local.get(
      key
    );

  return (
    stored[key] ||
    null
  );
}


async function patchMarketplaceAnalysisJobById(
  jobId,
  patch = {},
  options = {}
) {
  if (!jobId) {
    return null;
  }

  const existing =
    await getMarketplaceAnalysisJobById(
      jobId
    );

  if (
    !existing &&
    options.createIfMissing === false
  ) {
    return null;
  }

  const currentUrl =
    String(
      options.currentUrl ||
      patch.url ||
      ""
    ).split("?")[0];

  const now =
    Date.now();

  const updated = {
    ...(
      existing || {
        jobId,

        listingId:
          getFacebookMarketplaceItemId(
            currentUrl
          ) ||
          String(jobId)
            .replace(
              /^listing-/,
              ""
            ),

        url:
          currentUrl,

        createdAt:
          now
      }
    ),

    ...patch,

    jobId,

    updatedAt:
      now
  };

  await chrome.storage.local.set({
    [
      getMarketplaceAnalysisJobStorageKey(
        jobId
      )
    ]:
      updated
  });

  return updated;
}


async function upsertMarketplaceAnalysisJob(
  patch = {}
) {
  const jobId =
    getCurrentMarketplaceAnalysisJobId();

  if (!jobId) {
    return null;
  }

  return patchMarketplaceAnalysisJobById(
    jobId,
    patch,
    {
      currentUrl:
        window.location.href
          .split("?")[0]
    }
  );
}


async function removeCurrentMarketplaceAnalysisJob() {
  const jobId =
    getCurrentMarketplaceAnalysisJobId();

  if (!jobId) {
    return;
  }

  await chrome.storage.local.remove(
    getMarketplaceAnalysisJobStorageKey(
      jobId
    )
  );
}


async function countActiveMarketplaceAnalysisJobs() {
  const jobs =
    await getMarketplaceAnalysisJobs();

  return jobs.filter(
    job =>
      !isMarketplaceAnalysisJobTerminal(
        job
      )
  ).length;
}


async function failMarketplaceAnalysisJobById(
  jobId,
  failureReason,
  stage = "watchdog"
) {
  return patchMarketplaceAnalysisJobById(
    jobId,
    {
      status:
        "failed",

      stage,

      failureReason:
        String(
          failureReason ||
          "Analysis job failed."
        ),

      failedAt:
        Date.now()
    },
    {
      createIfMissing:
        false
    }
  );
}


async function pruneStaleMarketplaceAnalysisJobs() {
  const jobs =
    await getMarketplaceAnalysisJobs();

  const now =
    Date.now();

  for (const job of jobs) {
    if (
      !isMarketplaceAnalysisJobStale(
        job,
        now
      )
    ) {
      continue;
    }

    console.warn(
      "[PIPELINE WATCHDOG] Stale job:",
      job
    );

    await failMarketplaceAnalysisJobById(
      job.jobId,
      `Job remained stuck in "${job.status}" past its watchdog limit.`,
      "stale-watchdog"
    );

    const lockStored =
      await chrome.storage.local.get(
        MARKETPLACE_FINISH_LOCK_KEY
      );

    if (
      lockStored[
        MARKETPLACE_FINISH_LOCK_KEY
      ] === job.jobId
    ) {
      await chrome.storage.local.remove(
        MARKETPLACE_FINISH_LOCK_KEY
      );
    }
  }
}


async function clearMarketplaceAnalysisJobRegistry() {
  const stored =
    await chrome.storage.local.get(
      null
    );

  const keys = Object.keys(
    stored
  ).filter(
    key =>
      key.startsWith(
        MARKETPLACE_ANALYSIS_JOB_PREFIX
      )
  );

  await chrome.storage.local.remove([
    ...keys,

    // Remove data left by the old implementation too.
    MARKETPLACE_ANALYSIS_JOBS_KEY,

    MARKETPLACE_FINISH_LOCK_KEY
  ]);
}

async function acquireMarketplaceFinishLock() {
  const jobId =
    getCurrentMarketplaceAnalysisJobId();

  if (!jobId) {
    return;
  }


  while (true) {
    /*
      Prevent a crashed lock owner from blocking
      all future listings forever.
    */
    await pruneStaleMarketplaceAnalysisJobs();


    const stored =
      await chrome.storage.local.get(
        MARKETPLACE_FINISH_LOCK_KEY
      );

    const currentOwner =
      String(
        stored[
          MARKETPLACE_FINISH_LOCK_KEY
        ] ||
        ""
      ).trim();


    if (
      !currentOwner ||
      currentOwner ===
        jobId
    ) {
      await chrome.storage.local.set({
        [MARKETPLACE_FINISH_LOCK_KEY]:
          jobId
      });


      const verify =
        await chrome.storage.local.get(
          MARKETPLACE_FINISH_LOCK_KEY
        );


      if (
        verify[
          MARKETPLACE_FINISH_LOCK_KEY
        ] ===
          jobId
      ) {
        console.log(
          "[PIPELINE LOCK] Acquired finish lock:",
          jobId
        );

        return;
      }
    }


    const ownerJob =
      await getMarketplaceAnalysisJobById(
        currentOwner
      );


    if (
      currentOwner &&
      (
        !ownerJob ||
        isMarketplaceAnalysisJobTerminal(
          ownerJob
        ) ||
        isMarketplaceAnalysisJobStale(
          ownerJob
        )
      )
    ) {
      console.warn(
        "[PIPELINE LOCK] Removing stale lock:",
        {
          currentOwner,
          ownerStatus:
            ownerJob?.status ||
            "missing"
        }
      );

      await chrome.storage.local.remove(
        MARKETPLACE_FINISH_LOCK_KEY
      );

      continue;
    }


    console.log(
      "[PIPELINE LOCK] Waiting for older listing:",
      {
        jobId,
        currentOwner,
        ownerStatus:
          ownerJob?.status ||
          "missing"
      }
    );


    await sleep(
      500
    );
  }
}


async function releaseMarketplaceFinishLock() {
  const jobId =
    getCurrentMarketplaceAnalysisJobId();

  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_FINISH_LOCK_KEY
    );

  if (
    stored[
      MARKETPLACE_FINISH_LOCK_KEY
    ] === jobId
  ) {
    await chrome.storage.local.remove(
      MARKETPLACE_FINISH_LOCK_KEY
    );

    console.log(
      "[PIPELINE LOCK] Released finish lock:",
      jobId
    );
  }
}

async function runActiveEbayApiWorkflow(
  button
) {
  const stored =
    await chrome.storage.local.get(
      "ebayCompContext"
    );

  let context =
    stored.ebayCompContext;

  if (!context) {
    throw new Error(
      "Active eBay workflow started without ebayCompContext."
    );
  }

  const items =
    Array.isArray(
      context.items
    )
      ? context.items
      : [];

  let currentItemIndex =
    Number(
      context.currentItemIndex || 0
    );


  while (
    currentItemIndex <
    items.length
  ) {
    const currentItem =
      items[
        currentItemIndex
      ];

    button.innerText =
      `Checking active eBay market ${currentItemIndex + 1}/${items.length}...`;

    console.log(
      "[ACTIVE EBAY] Evaluating:",
      currentItem.ebaySearchQuery
    );


    const response =
      await fetchLocalServer(
        "/evaluate-active-comps",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              target: {
                ...currentItem,

                facebookPrice:
                  context.facebookPrice,

                originalFacebookTitle:
                  context.originalFacebookTitle,

                facebookDescription:
                  context.facebookDescription
              }
            })
        }
      );


    const itemResult =
      await readJsonSafely(
        response
      );


    if (
      !response.ok ||
      itemResult.error
    ) {
      throw new LocalServerError(
        itemResult,
        "Active eBay valuation failed."
      );
    }


    console.log(
      "[ACTIVE EBAY] Result:",
      itemResult
    );


    context = {
      ...context,

      results: [
        ...(context.results || []),

        {
          item:
            currentItem,

          result:
            itemResult
        }
      ],

      currentItemIndex:
        currentItemIndex + 1
    };


    await chrome.storage.local.set({
      ebayCompContext:
        context
    });


    currentItemIndex += 1;
  }


  /*
    All database misses have now received
    active-market valuations.

    Run the existing final lot calculation.
  */
  const finalResponse =
    await fetchLocalServer(
      "/evaluate-lot",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            context
          })
      }
    );


  const finalResult =
    await readJsonSafely(
      finalResponse
    );


  if (
    !finalResponse.ok ||
    finalResult.error
  ) {
    throw new LocalServerError(
      finalResult,
      "Final active-market lot evaluation failed."
    );
  }


  console.log(
    "[ACTIVE EBAY] Final lot evaluation:",
    finalResult
  );


  if (
    String(
      finalResult.recommendation ||
      ""
    )
      .trim()
      .toLowerCase() ===
    "scam"
  ) {
    await saveScamListing({
      context,
      result:
        finalResult
    });
  }


  await saveDealToLibrary({
    context,
    result:
      finalResult
  });


  if (
    !isHitRecommendation(
      finalResult
    )
  ) {
    await markMarketplaceAnalysisRunCompleted();
  }


  await markMarketplaceAutoAnalysisComplete(
    finalResult
  );


  showLotCompPanel(
    finalResult
  );
}

function getListingTitle() {
  const badTitles = [
    "notifications",
    "marketplace",
    "facebook",
    "menu",
    "search",
    "watch",
    "groups",
    "friends",
    "home",
    "create",
    "gaming",
    "saved",
    "inbox",
    "sell",
    "buy and sell groups",
    "today's picks",
    "top picks",
    "recommended for you",
    "message seller",
    "seller information",
    "details",
    "description"
  ];

  function cleanText(text) {
    return text ? text.replace(/\s+/g, " ").trim() : "";
  }

  function isGoodTitle(text) {
    const cleaned = cleanText(text);
    const lower = cleaned.toLowerCase();

    if (!cleaned) return false;
    if (cleaned.length < 5) return false;
    if (cleaned.length > 120) return false;

    if (badTitles.includes(lower)) return false;
    if (lower.includes("facebook")) return false;
    if (lower.includes("marketplace")) return false;
    if (lower.includes("notifications")) return false;
    if (lower.includes("log in")) return false;
    if (lower.includes("sign up")) return false;
    if (lower.includes("message seller")) return false;
    if (lower.includes("seller information")) return false;

    return true;
  }

  // Best first attempt: browser tab title
  if (document.title) {
    const titleFromPage = cleanText(
      document.title
        .replace("| Facebook Marketplace", "")
        .replace("| Marketplace", "")
        .replace("| Facebook", "")
    );

    if (isGoodTitle(titleFromPage)) {
      return titleFromPage;
    }
  }

  // Try all h1s, not just the first one
  const h1s = Array.from(document.querySelectorAll("h1"))
    .map(el => cleanText(el.innerText))
    .filter(isGoodTitle);

  if (h1s.length > 0) {
    return h1s[0];
  }

  // Last fallback: scan visible text
  const candidates = Array.from(document.querySelectorAll("span, div"))
    .map(el => cleanText(el.innerText))
    .filter(isGoodTitle)
    .filter(text => !text.includes("\n"));

  console.log("Title candidates:", candidates.slice(0, 50));

  return candidates[0] || "";
}

/*
  ============================================================
  REMOTE EBAY WORKER
  ============================================================

  IMPORTANT:
  This decision is made ONCE per Marketplace listing.

  It is NOT randomized separately for:
    - each product
    - each bundle item
    - pollution reruns

  Therefore a selected Marketplace listing uses the
  remote eBay worker for its entire eBay workflow.
*/

const REMOTE_EBAY_HANDOFF_ENABLED =
  false;

/*
  10 = approximately 1 out of every 10 listings that
  actually require an eBay search.

  Change this number to your desired denominator.
*/
const REMOTE_EBAY_ONE_IN_N_LISTINGS = 2;

const REMOTE_EBAY_JOB_POLL_INTERVAL_MS =
  1000;

const REMOTE_EBAY_JOB_TIMEOUT_MS =
  5 * 60 * 1000;

  function shouldUseRemoteEbayForListing() {
  if (
    !REMOTE_EBAY_HANDOFF_ENABLED
  ) {
    return false;
  }

  const denominator =
    Math.max(
      1,
      Math.floor(
        Number(
          REMOTE_EBAY_ONE_IN_N_LISTINGS
        ) || 1
      )
    );

  if (
    denominator === 1
  ) {
    return true;
  }

  return (
    Math.floor(
      Math.random() *
        denominator
    ) === 0
  );
}

  function parseMessengerThreadTimestampText(
  text
) {
  const value =
    String(text || "")
      .trim()
      .replace(/\u202f/g, " ")
      .replace(/\s+/g, " ");


  if (!value) {
    return null;
  }


  const now =
    new Date();


  /*
    Example:
    Sun 6:50 PM
    Monday/weekday-style timestamps from Messenger.
  */
  const weekdayMatch =
    value.match(
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i
    );


  if (weekdayMatch) {
    const weekdayNames = [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat"
    ];


    const targetWeekday =
      weekdayNames.findIndex(
        day =>
          day.toLowerCase() ===
          weekdayMatch[1].toLowerCase()
      );


    let hour =
      Number(
        weekdayMatch[2]
      );


    const minute =
      Number(
        weekdayMatch[3]
      );


    const meridiem =
      weekdayMatch[4]
        .toUpperCase();


    if (
      meridiem === "PM" &&
      hour !== 12
    ) {
      hour += 12;
    }


    if (
      meridiem === "AM" &&
      hour === 12
    ) {
      hour = 0;
    }


    const result =
      new Date(now);


    /*
      Go backward to the most recent occurrence
      of that weekday.
    */
    let daysBack =
      (
        now.getDay() -
        targetWeekday +
        7
      ) % 7;


    result.setDate(
      now.getDate() -
      daysBack
    );


    result.setHours(
      hour,
      minute,
      0,
      0
    );


    /*
      If the calculated time is somehow in the future,
      use the previous week's occurrence.
    */
    if (
      result.getTime() >
      now.getTime()
    ) {
      result.setDate(
        result.getDate() - 7
      );
    }


    return result.toISOString();
  }




  /*
    Messenger may also show something like:
    6:50 PM
  */
  const timeOnlyMatch =
    value.match(
      /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i
    );


  if (timeOnlyMatch) {
    let hour =
      Number(
        timeOnlyMatch[1]
      );


    const minute =
      Number(
        timeOnlyMatch[2]
      );


    const meridiem =
      timeOnlyMatch[3]
        .toUpperCase();


    if (
      meridiem === "PM" &&
      hour !== 12
    ) {
      hour += 12;
    }


    if (
      meridiem === "AM" &&
      hour === 12
    ) {
      hour = 0;
    }


    const result =
      new Date(now);


    result.setHours(
      hour,
      minute,
      0,
      0
    );


    /*
      If today's interpretation is in the future,
      assume yesterday.
    */
    if (
      result.getTime() >
      now.getTime()
    ) {
      result.setDate(
        result.getDate() - 1
      );
    }


    return result.toISOString();
  }




  return null;
}

function getLatestMessengerThreadTimestamp() {
  const timestampSpans =
    Array.from(
      document.querySelectorAll(
        "span"
      )
    )
      .map(
        element => ({
          element,


          text:
            String(
              element.textContent ||
              ""
            )
              .trim()
              .replace(/\u202f/g, " ")
              .replace(/\s+/g, " ")
        })
      )
      .filter(
        entry =>
          /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{1,2}:\d{2}\s*(AM|PM)$/i.test(
            entry.text
          ) ||
          /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(
            entry.text
          )
      );




  if (!timestampSpans.length) {
    return {
      text: "",
      iso:
        null
    };
  }




  /*
    The last matching timestamp in DOM order
    should correspond to the latest rendered
    timestamp group in the conversation.
  */
  const latest =
    timestampSpans[
      timestampSpans.length -
      1
    ];




  return {
    text:
      latest.text,


    iso:
      parseMessengerThreadTimestampText(
        latest.text
      )
  };
}

const MARKETPLACE_MAPPED_CONVERSATIONS_KEY =
  "marketplaceMappedConversationIds";


async function getMappedMarketplaceConversationIds() {
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_MAPPED_CONVERSATIONS_KEY
    );

  return new Set(
    Array.isArray(
      stored[
        MARKETPLACE_MAPPED_CONVERSATIONS_KEY
      ]
    )
      ? stored[
          MARKETPLACE_MAPPED_CONVERSATIONS_KEY
        ]
      : []
  );
}


async function rememberMappedMarketplaceConversation(
  conversationId
) {
  if (!conversationId) {
    return;
  }

  const mapped =
    await getMappedMarketplaceConversationIds();

  mapped.add(
    String(
      conversationId
    )
  );

  await chrome.storage.local.set({
    [MARKETPLACE_MAPPED_CONVERSATIONS_KEY]:
      [...mapped]
  });
}

const MARKETPLACE_AUTO_STATE_KEY = "marketplaceAutoAnalyzerState";

function createMarketplaceOutreachSessionId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return (
    Date.now() +
    "_" +
    Math.random()
      .toString(36)
      .slice(2)
  );
}

const MARKETPLACE_ANALYSIS_RUN_KEY =
  "marketplaceCurrentAnalysisRun";

const SCAM_LISTINGS_KEY = "scamMarketplaceListings";

const SESSION_LISTINGS_KEY = "sessionListingsLibrary";

const LIBRARY_SAVING_ENABLED_KEY =
  "marketplaceLibrarySavingEnabled";

const MARKETPLACE_MESSAGED_LISTING_IDS_KEY =
  "marketplaceMessagedListingIds";

  async function isLibrarySavingEnabled() {
  const stored = await chrome.storage.local.get(
    LIBRARY_SAVING_ENABLED_KEY
  );

  return stored[LIBRARY_SAVING_ENABLED_KEY] === true;
}

async function setLibrarySavingEnabled(enabled) {
  await chrome.storage.local.set({
    [LIBRARY_SAVING_ENABLED_KEY]: enabled === true
  });
}

// other normal functions continue below

const MARKETPLACE_HIT_MESSAGE =
  "Hi, I’d love to buy this. I’m not local, but I’ll cover the full shipping cost if you're willing.";

function isHitRecommendation(result) {
  const recommendation =
    String(
      result?.recommendation || ""
    )
      .trim()
      .toLowerCase();

  return (
    recommendation === "buy now" ||
    recommendation === "negotiate"
  );
}

const LISTING_ANALYSIS_RETRY_KEY =
  "marketplaceAnalysisRetryByListingId";

const MAX_LISTING_ANALYSIS_RETRIES = 1;

const MAX_FACEBOOK_ASK_PRICE = 300;

/*
  ============================================================
  HIT OUTREACH MODE
  ============================================================

  true:
    Scanner DOES NOT message the seller.
    Hit is queued for the separate outreach extension.

  false:
    Scanner immediately messages the seller itself.
*/
const USE_SEPARATE_OUTREACH_EXTENSION = false;

/*
  ============================================================
  REMOTE GOOGLE LENS WORKER
  ============================================================
*/

const REMOTE_GOOGLE_LENS_JOB_POLL_INTERVAL_MS =
  1000;

const REMOTE_GOOGLE_LENS_JOB_TIMEOUT_MS =
  5 * 60 * 1000;


async function createRemoteGoogleLensJob({
  targets
}) {
  const facebookUrl =
    getCurrentFacebookListingUrl()
      .split("?")[0];

  const marketplaceListingId =
    getFacebookMarketplaceItemId(
      facebookUrl
    );

  const response =
    await fetchLocalServer(
      "/google-lens-worker/jobs",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            targets,

            marketplaceListingId,

            marketplaceUrl:
              facebookUrl
          })
      }
    );

  const data =
    await readJsonSafely(
      response
    );

  if (
    !response.ok ||
    data?.ok !== true ||
    !data?.jobId
  ) {
    throw new Error(
      data?.error ||
      "Could not queue remote Google Lens job."
    );
  }

  console.log(
    "[REMOTE GOOGLE LENS] Job queued:",
    {
      jobId:
        data.jobId,

      targets:
        targets.length
    }
  );

  return data;
}

/*
  ============================================================
  GOOGLE LENS ROUTING
  ============================================================

  1 = every Lens-required listing goes remote
  2 = approximately 1 out of 2
  5 = approximately 1 out of 5
  10 = approximately 1 out of 10

  Listings not selected use THIS extension's local
  Google Lens implementation.
*/

const REMOTE_GOOGLE_LENS_HANDOFF_ENABLED =
  false;

const REMOTE_GOOGLE_LENS_ONE_IN_N_LISTINGS =
  2;


function shouldUseRemoteGoogleLensForListing() {
  if (
    !REMOTE_GOOGLE_LENS_HANDOFF_ENABLED
  ) {
    return false;
  }

  const denominator =
    Math.max(
      1,
      Math.floor(
        Number(
          REMOTE_GOOGLE_LENS_ONE_IN_N_LISTINGS
        ) || 1
      )
    );

  if (
    denominator === 1
  ) {
    return true;
  }

  return (
    Math.floor(
      Math.random() *
        denominator
    ) === 0
  );
}


async function waitForRemoteGoogleLensJob(
  jobId
) {
  const startedAt =
    Date.now();

  while (
    Date.now() -
      startedAt <
    REMOTE_GOOGLE_LENS_JOB_TIMEOUT_MS
  ) {
    const response =
      await fetchLocalServer(
        `/google-lens-worker/jobs/${encodeURIComponent(
          jobId
        )}`,
        {
          method:
            "GET",

          cache:
            "no-store"
        }
      );

    const data =
      await readJsonSafely(
        response
      );

    if (
      !response.ok ||
      data?.ok !== true
    ) {
      throw new Error(
        data?.error ||
        "Could not read remote Google Lens job."
      );
    }

    if (
      data.status ===
      "completed"
    ) {
      const results =
        Array.isArray(
          data.results
        )
          ? data.results
          : [];

      console.log(
        "[REMOTE GOOGLE LENS] Results received:",
        {
          jobId,

          results:
            results.length
        }
      );

      return results;
    }

    if (
      data.status ===
      "failed"
    ) {
      throw new Error(
        data.error ||
        "Remote Google Lens worker reported failure."
      );
    }

    await sleep(
      REMOTE_GOOGLE_LENS_JOB_POLL_INTERVAL_MS
    );
  }

  throw new Error(
    "Remote Google Lens worker timed out."
  );
}


async function runRemoteGoogleLensTargets(
  targets
) {
  console.log(
    "[REMOTE GOOGLE LENS] Sending targets to worker:",
    targets
  );

  const job =
    await createRemoteGoogleLensJob({
      targets
    });

  return await waitForRemoteGoogleLensJob(
    job.jobId
  );
}

async function prepareDataForSeoCrops(
  targets,
  initialIdentificationData,
  productOcrResults
) {
  const primaryProducts =
    Array.isArray(
      initialIdentificationData
        ?.primaryProducts
    )
      ? initialIdentificationData
          .primaryProducts
      : [];


  const enrichedTargets =
    targets.map(
      target => {
        const product =
          primaryProducts.find(
            item =>
              String(
                item?.productId ||
                ""
              ).trim() ===
              String(
                target?.productId ||
                ""
              ).trim()
          );


        const productOcr =
          productOcrResults.find(
            item =>
              String(
                item?.productId ||
                ""
              ).trim() ===
              String(
                target?.productId ||
                ""
              ).trim()
          );


        return {
          ...target,

          /*
            Partial existing identity is ONLY a localization hint.

            It is not a new identification step.
          */
          knownProduct:
            product
              ? {
                  brand:
                    product?.brand ||
                    product
                      ?.lensIdentity
                      ?.brand ||
                    null,

                  model:
                    product?.model ||
                    null,

                  productType:
                    product?.productType ||
                    target.productType,

                  lensIdentity:
                    product?.lensIdentity ||
                    null
                }
              : null,

          ocrText:
            String(
              productOcr?.ocrText ||
              ""
            ).trim()
        };
      }
    );


  console.log(
    "[DATAFORSEO CROP] Requesting isolated product crops:",
    enrichedTargets
  );


  const response =
    await fetchLocalServer(
      "/prepare-dataforseo-crops",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            targets:
              enrichedTargets
          })
      }
    );


  const data =
    await readJsonSafely(
      response
    );


  if (
    !response.ok ||
    data?.ok !== true
  ) {
    throw new LocalServerError(
      data,
      "Could not prepare isolated DataForSEO product crops."
    );
  }


  const prepared =
    Array.isArray(
      data?.targets
    )
      ? data.targets
      : [];


  const byProductId =
    new Map(
      prepared.map(
        target => [
          String(
            target?.productId ||
            ""
          ).trim(),

          target
        ]
      )
    );


  return targets.map(
    target => {
      const preparedTarget =
        byProductId.get(
          String(
            target?.productId ||
            ""
          ).trim()
        );


      return {
        ...target,

        cropPrepared:
          preparedTarget
            ?.cropPrepared ===
          true,

        dataForSeoImageUrl:
          String(
            preparedTarget
              ?.dataForSeoImageUrl ||
            ""
          ).trim(),

        dataForSeoCropObjectPath:
          String(
            preparedTarget
              ?.dataForSeoCropObjectPath ||
            ""
          ).trim(),

        cropBoundingBox:
          preparedTarget
            ?.cropBoundingBox ||
          null,

        cropError:
          String(
            preparedTarget
              ?.cropError ||
            ""
          ).trim(),

        /*
          CRITICAL:

          DataForSEO now receives an ISOLATED PRODUCT crop.

          Do NOT retain the old whole-image ambiguity state,
          otherwise background.js may ask DataForSEO to identify
          multiple lenses inside a crop containing only one lens.
        */
        sameTypeProductIds: [
          String(
            target.productId
          ).trim()
        ]
      };
    }
  );
}

async function runLocalGoogleLensTargets(
  targets
) {
  console.log(
    "[LOCAL GOOGLE LENS] Sending targets to main extension background:",
    targets
  );

  const response =
  await chrome.runtime.sendMessage({
    type:
      "PROCESS_SELECTED_GOOGLE_LENS_TARGETS",

    targets
  });

  if (
    !response ||
    response.ok !== true
  ) {
    throw new Error(
      response?.error ||
      "Local Google Lens processing failed."
    );
  }

  const results =
    Array.isArray(
      response.results
    )
      ? response.results
      : [];

  console.log(
    "[LOCAL GOOGLE LENS] Results received:",
    results
  );

  return results;
}

const LISTING_JSON_RETRY_KEY =
  "marketplaceMalformedJsonRetryByListingId";

const MAX_FULL_LISTING_JSON_RESTARTS = 2;

const MARKETPLACE_RANDOM_KEYWORD_MODE = "randomKeyword";

const MARKETPLACE_SEARCH_EXHAUSTION_DELAY_MS =
  30 * 1000;

const MARKETPLACE_SEARCH_TERMS = [
  "digital camera",
  "DSLR",
  "mirrorless camera",
  "film camera",
  "vintage camera",
  "old camera",
  "camera bundle",
  "camera lot",
  "camera equipment",
  "photography equipment",
  "camera gear",
  "camera with lens",
  "interchangeable lens camera",
  "professional camera",
  "vlogging camera",
  "point and shoot camera",
  "digital video camera",

  "camera",
  "Canon",
  "Nikon",
  "Sony camera",
  "Fujifilm camera",
  "Panasonic camera",
  "Olympus camera",
  "Pentax camera",
  "Minolta camera",

  "Canon EOS",
  "Nikon DSLR",
  "Sony Alpha",
  "Fuji camera",
  "Lumix camera",
  "Olympus OM",
  "Pentax DSLR",

  "camera lens",
  "Canon lens",
  "Nikon lens",
  "Sony lens",
  "vintage lens",
  "zoom lens",
  "prime lens",
  "telephoto lens",
  "wide angle lens",
  "DSLR lens",
  "EF lens",
  "EF-S lens",
  "RF lens",
  "FD lens",
  "F mount lens",
  "E mount lens",
  "Micro Four Thirds lens",
  "18-55mm lens",
  "50mm lens",
  "35mm lens",
  "75-300mm lens",
  "70-300mm lens",
  "55-200mm lens",
  "55-250mm lens",

  "camara",
  "cannon camera",
  "cannon lens",
  "nikon camara",
  "camera lense",
  "camcorder",
  "photography stuff",
  "photo camera",
  "digital cam",
  "rebel camera"
];

function normalizeMarketplaceSearchTerm(term) {
  return String(term || "")
    .trim()
    .toLowerCase();
}

function getMarketplaceSearchTermFromUrl(
  url = window.location.href
) {
  try {
    const parsed = new URL(
      url,
      window.location.origin
    );

    return (
      parsed.searchParams.get("query") || ""
    ).trim();
  } catch (error) {
    console.warn(
      "Could not read Marketplace search term:",
      error
    );

    return "";
  }
}

function buildMarketplaceSearchUrl(
  sourceUrl,
  searchTerm
) {
  const parsed = new URL(
    sourceUrl,
    window.location.origin
  );

  parsed.searchParams.set(
    "query",
    String(searchTerm || "").trim()
  );

  parsed.searchParams.set(
    "exact",
    "false"
  );

  return parsed.toString();
}

function pickRandomMarketplaceSearchTerm({
  currentTerm = "",
  usedTerms = []
} = {}) {
  const normalizedCurrent =
    normalizeMarketplaceSearchTerm(
      currentTerm
    );

  const normalizedUsed = new Set(
    Array.isArray(usedTerms)
      ? usedTerms.map(
          normalizeMarketplaceSearchTerm
        )
      : []
  );

  /*
    First try terms that have not been used during
    this keyword cycle and are not the current term.
  */
  let available =
    MARKETPLACE_SEARCH_TERMS.filter(term => {
      const normalized =
        normalizeMarketplaceSearchTerm(term);

      return (
        normalized !== normalizedCurrent &&
        !normalizedUsed.has(normalized)
      );
    });

  /*
    Once every term has been used, start a new cycle.
  */
  if (!available.length) {
    available =
      MARKETPLACE_SEARCH_TERMS.filter(term => {
        return (
          normalizeMarketplaceSearchTerm(term) !==
          normalizedCurrent
        );
      });
  }

  if (!available.length) {
    return currentTerm || "camera";
  }

  return available[
    Math.floor(
      Math.random() * available.length
    )
  ];
}

async function switchToRandomMarketplaceSearchTerm(
  reason = "Current search exhausted"
) {
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

  const state =
    stored[MARKETPLACE_AUTO_STATE_KEY];

  if (
    !state?.running ||
    state.scanMode !==
      MARKETPLACE_RANDOM_KEYWORD_MODE
  ) {
    return false;
  }

  const currentTerm =
    state.currentSearchTerm ||
    getMarketplaceSearchTermFromUrl(
      state.listUrl ||
      window.location.href
    );

  const usedTerms =
    Array.isArray(state.usedSearchTerms)
      ? state.usedSearchTerms
      : [];

  const nextTerm =
    pickRandomMarketplaceSearchTerm({
      currentTerm,
      usedTerms
    });

  const allTermsUsed =
    new Set(
      usedTerms.map(
        normalizeMarketplaceSearchTerm
      )
    ).size >=
    MARKETPLACE_SEARCH_TERMS.length - 1;

  const nextUsedTerms =
    allTermsUsed
      ? [nextTerm]
      : [...usedTerms, nextTerm];

  const baseUrl =
    state.listUrl ||
    window.location.href;

  const nextUrl =
    buildMarketplaceSearchUrl(
      baseUrl,
      nextTerm
    );

  const now = Date.now();

  const nextState = {
    ...state,

    listUrl: nextUrl,

    currentSearchTerm: nextTerm,
    previousSearchTerm: currentTerm,

    usedSearchTerms: nextUsedTerms,

    currentListingUrl: "",
    waitingForAnalysis: false,
    analysisDone: false,

    noFreshListingSince: null,
    lastFreshListingOpenedAt: now,

    searchStartedAt: now,

    searchSwitchCount:
      Number(
        state.searchSwitchCount || 0
      ) + 1,

    lastSearchSwitchReason: reason,
    lastSearchSwitchAt: now
  };

  await chrome.storage.local.set({
    [MARKETPLACE_AUTO_STATE_KEY]:
      nextState
  });

  console.log(
    "[KEYWORD SWITCH]",
    {
      from: currentTerm,
      to: nextTerm,
      reason,
      nextUrl
    }
  );

  /*
    Changing location loads the new query and acts
    as the required page refresh.
  */
  window.location.href = nextUrl;

  return true;
}

async function getListingAnalysisRetryCount(listingId) {
  if (!listingId) return 0;

  const stored = await chrome.storage.local.get(
    LISTING_ANALYSIS_RETRY_KEY
  );

  const retryMap =
    stored[LISTING_ANALYSIS_RETRY_KEY] || {};

  return Number(retryMap[listingId] || 0);
}

async function incrementListingAnalysisRetryCount(listingId) {
  if (!listingId) return 0;

  const stored = await chrome.storage.local.get(
    LISTING_ANALYSIS_RETRY_KEY
  );

  const retryMap = {
    ...(stored[LISTING_ANALYSIS_RETRY_KEY] || {})
  };

  retryMap[listingId] =
    Number(retryMap[listingId] || 0) + 1;

  await chrome.storage.local.set({
    [LISTING_ANALYSIS_RETRY_KEY]: retryMap
  });

  return retryMap[listingId];
}

async function clearListingAnalysisRetryCount(listingId) {
  if (!listingId) return;

  const stored = await chrome.storage.local.get(
    LISTING_ANALYSIS_RETRY_KEY
  );

  const retryMap = {
    ...(stored[LISTING_ANALYSIS_RETRY_KEY] || {})
  };

  delete retryMap[listingId];

  await chrome.storage.local.set({
    [LISTING_ANALYSIS_RETRY_KEY]: retryMap
  });
}

async function getMalformedJsonRetryCount(listingId) {
  const stored = await chrome.storage.local.get(
    LISTING_JSON_RETRY_KEY
  );

  const retryMap =
    stored[LISTING_JSON_RETRY_KEY] || {};

  return Number(retryMap[listingId] || 0);
}

async function incrementMalformedJsonRetryCount(listingId) {
  const stored = await chrome.storage.local.get(
    LISTING_JSON_RETRY_KEY
  );

  const retryMap = {
    ...(stored[LISTING_JSON_RETRY_KEY] || {})
  };

  retryMap[listingId] =
    Number(retryMap[listingId] || 0) + 1;

  await chrome.storage.local.set({
    [LISTING_JSON_RETRY_KEY]: retryMap
  });

  return retryMap[listingId];
}

async function clearMalformedJsonRetryCount(listingId) {
  const stored = await chrome.storage.local.get(
    LISTING_JSON_RETRY_KEY
  );

  const retryMap = {
    ...(stored[LISTING_JSON_RETRY_KEY] || {})
  };

  delete retryMap[listingId];

  await chrome.storage.local.set({
    [LISTING_JSON_RETRY_KEY]: retryMap
  });
}

function isExtensionContextInvalidated(error) {
  return String(error?.message || error || "")
    .toLowerCase()
    .includes("extension context invalidated");
}

function handleExtensionContextError(error) {
  if (!isExtensionContextInvalidated(error)) {
    return false;
  }

  console.warn(
    "Extension context was invalidated. Refresh this tab before continuing."
  );

  return true;
}

async function restartEntireFacebookListingScanBecauseMalformedJson({
  step = "unknown",
  errorMessage = ""
} = {}) {
  const stored = await chrome.storage.local.get([
    "ebayCompContext",
    MARKETPLACE_AUTO_STATE_KEY
  ]);

  const context = stored.ebayCompContext || {};
  const autoState =
    stored[MARKETPLACE_AUTO_STATE_KEY] || {};

  const facebookUrl = String(
    context.facebookUrl ||
    autoState.currentListingUrl ||
    ""
  ).split("?")[0];

  const listingId =
    getFacebookMarketplaceItemId(facebookUrl);

  if (!facebookUrl || !listingId) {
    throw new Error(
      "Could not determine the Facebook listing URL for JSON restart."
    );
  }

  const previousCount =
    await getMalformedJsonRetryCount(listingId);

  if (
    previousCount >= MAX_FULL_LISTING_JSON_RESTARTS
  ) {
    const finalError = {
      recommendation: "Error",
      reason:
        `The listing produced malformed AI JSON repeatedly during ` +
        `${step}. Full scan restart limit reached. ` +
        `${errorMessage}`.trim()
    };

await markMarketplaceAutoAnalysisComplete(
  finalError,
  {
    preserveMalformedJsonRetryCount: true
  }
);
    showEbayCompPanel(finalError);

    return false;
  }

  const nextCount =
    await incrementMalformedJsonRetryCount(listingId);

  console.warn(
    `Restarting full listing scan after malformed JSON. ` +
    `Attempt ${nextCount}/${MAX_FULL_LISTING_JSON_RESTARTS}.`,
    {
      listingId,
      facebookUrl,
      step,
      errorMessage
    }
  );

  await chrome.storage.local.remove(
    "ebayCompContext"
  );

  await chrome.storage.local.set({
    marketplacePendingMalformedJsonRestart: {
      listingId,
      facebookUrl,
      step,
      retryNumber: nextCount,
      requestedAt: Date.now()
    },

    [MARKETPLACE_AUTO_STATE_KEY]: {
      ...autoState,
      currentListingUrl: facebookUrl,
      waitingForAnalysis: false,
      analysisDone: false,
      lastResult: {
        recommendation: "Restarting",
        reason:
          `Malformed AI JSON during ${step}. ` +
          `Restarting the entire listing scan.`
      }
    }
  });

  await closeMarketplaceAutoEbayTabs();

  window.location.href = facebookUrl;
  return true;
}

async function resumeMalformedJsonListingRestartIfNeeded() {
  if (!isFacebookMarketplaceListingPage()) {
    return false;
  }

  const stored = await chrome.storage.local.get(
    "marketplacePendingMalformedJsonRestart"
  );

  const pending =
    stored.marketplacePendingMalformedJsonRestart;

  if (!pending) {
    return false;
  }

  const currentUrl =
    window.location.href.split("?")[0];

  const currentListingId =
    getFacebookMarketplaceItemId(currentUrl);

  if (currentListingId !== pending.listingId) {
    return false;
  }

  if (
    Date.now() - Number(pending.requestedAt || 0) >
    10 * 60 * 1000
  ) {
    console.warn(
      "Discarding expired malformed-JSON restart request:",
      pending
    );

    await chrome.storage.local.remove(
      "marketplacePendingMalformedJsonRestart"
    );

    return false;
  }

  // Remove it before starting the scan so a page refresh does not
  // trigger the same pending restart repeatedly.
  await chrome.storage.local.remove(
    "marketplacePendingMalformedJsonRestart"
  );

  await sleep(1500);

  console.log(
    "Restarting complete listing analysis after malformed JSON:",
    pending
  );

  await aiCheckListing();

  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isVisibleMarketplaceElement(element) {
  if (!element) return false;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  );
}

async function waitForMarketplaceElement(
  getElement,
  timeoutMs = 12000
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const element = getElement();

    if (isVisibleMarketplaceElement(element)) {
      return element;
    }

    await sleep(250);
  }

  return null;
}

function findMarketplaceSellerMessageInput() {
  const selectors = [
    'textarea[data-interactable*="keyup"]',
    'textarea',
    'input[placeholder*="available" i]',
    'textarea[placeholder*="available" i]',
    'input[aria-label*="message" i]',
    'textarea[aria-label*="message" i]',
    '[contenteditable="true"][role="textbox"]'
  ];

  const candidates = [
    ...new Set(
      selectors.flatMap(selector =>
        Array.from(
          document.querySelectorAll(selector)
        )
      )
    )
  ];

  const validCandidates =
    candidates.filter(element => {
      if (!isVisibleMarketplaceElement(element)) {
        return false;
      }

      if (
        element instanceof HTMLTextAreaElement
      ) {
        const value =
          String(element.value || "")
            .trim()
            .toLowerCase();

        const interactable =
          String(
            element.getAttribute(
              "data-interactable"
            ) || ""
          ).toLowerCase();

       const normalizedValue =
  value
    .replace(
      /\bstill\b/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();

return (
  normalizedValue.includes(
    "is this available"
  ) ||
  interactable.includes(
    "keyup"
  )
);
      }

      return true;
    });

  /*
    Prefer the seller field in the listing details
    panel on the right half of the page.
  */
  const rightSideInput =
    validCandidates.find(element => {
      const rect =
        element.getBoundingClientRect();

      return (
        rect.left >
        window.innerWidth * 0.5
      );
    });

  return (
    rightSideInput ||
    validCandidates[0] ||
    null
  );
}

function setMarketplaceMessageInputValue(
  input,
  message
) {
  input.scrollIntoView({
    block: "center",
    inline: "nearest"
  });

  input.focus();

  /*
    Select and remove Facebook's default message first.
    Facebook often ignores a direct value replacement
    unless keyboard-like events also occur.
  */
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      bubbles: true
    })
  );

  if (
    input instanceof HTMLInputElement ||
    input instanceof HTMLTextAreaElement
  ) {
    input.select();

    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const setter =
      Object.getOwnPropertyDescriptor(
        prototype,
        "value"
      )?.set;

    if (setter) {
      setter.call(input, "");
    } else {
      input.value = "";
    }

    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType:
          "deleteContentBackward",
        data: null
      })
    );

    if (setter) {
      setter.call(input, message);
    } else {
      input.value = message;
    }
  } else if (input.isContentEditable) {
    input.textContent = "";

    const selection =
      window.getSelection();

    const range =
      document.createRange();

    range.selectNodeContents(input);
    range.collapse(true);

    selection.removeAllRanges();
    selection.addRange(range);

    const inserted =
      document.execCommand(
        "insertText",
        false,
        message
      );

    if (!inserted) {
      input.textContent = message;
    }
  }

  input.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: message
    })
  );

  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: message
    })
  );

  input.dispatchEvent(
    new Event("change", {
      bubbles: true
    })
  );

  input.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Unidentified",
      bubbles: true
    })
  );

  input.blur();
  input.focus();
}

function findMarketplaceSellerSendButton(input) {
  let container = input;

  /*
    Search around the message box first so another
    Facebook "Send" button is not accidentally clicked.
  */
  for (
    let level = 0;
    level < 7 && container;
    level += 1
  ) {
    const buttons = Array.from(
      container.querySelectorAll?.(
        'button, [role="button"]'
      ) || []
    );

    const sendButton = buttons.find(element => {
      const text = String(
        element.innerText ||
        element.textContent ||
        element.getAttribute("aria-label") ||
        ""
      )
        .trim()
        .toLowerCase();

      return (
        isVisibleMarketplaceElement(element) &&
        text === "send"
      );
    });

    if (sendButton) {
      return sendButton;
    }

    container = container.parentElement;
  }

  /*
    Fallback: find a visible Send button on the
    right half of the listing page.
  */
  return (
    Array.from(
      document.querySelectorAll(
        'button, [role="button"]'
      )
    ).find(element => {
      if (!isVisibleMarketplaceElement(element)) {
        return false;
      }

      const text = String(
  element.innerText ||
  element.textContent ||
  element.getAttribute(
    "aria-label"
  ) ||
  ""
)
  .trim()
  .toLowerCase();

      const rect = element.getBoundingClientRect();

      return (
        text === "send" &&
        rect.left > window.innerWidth * 0.5
      );
    }) || null
  );
}

async function getMessagedMarketplaceListingIds() {
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_MESSAGED_LISTING_IDS_KEY
    );

  const ids =
    stored[
      MARKETPLACE_MESSAGED_LISTING_IDS_KEY
    ];

  return Array.isArray(ids) ? ids : [];
}

async function markMarketplaceListingMessaged(
  listingId
) {
  if (!listingId) return;

  const ids =
    await getMessagedMarketplaceListingIds();

  if (ids.includes(listingId)) {
    return;
  }

  await chrome.storage.local.set({
    [MARKETPLACE_MESSAGED_LISTING_IDS_KEY]: [
      listingId,
      ...ids
    ].slice(0, 1000)
  });
}

async function generateTailoredMarketplaceHitMessage() {
  const stored =
    await chrome.storage.local.get([
      "ebayCompContext",
      "marketplaceFinalPrimaryProducts"
    ]);

  const context =
    stored?.ebayCompContext || {};

  const primaryProducts =
    Array.isArray(
      stored?.marketplaceFinalPrimaryProducts
    )
      ? stored.marketplaceFinalPrimaryProducts
      : [];

  const listingTitle =
    String(
      context.originalFacebookTitle ||
      getListingTitle() ||
      ""
    ).trim();

const listingDescription =
  String(
    context.facebookDescription ||
    ""
  ).trim();

  const response =
    await fetchLocalServer(
      "/generate-marketplace-hit-message",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            listingTitle,
            listingDescription,
            primaryProducts,

            templateMessage:
              MARKETPLACE_HIT_MESSAGE
          })
      },
      {
        timeoutMs: 30000,
        retries: 0
      }
    );

  const data =
    await readJsonSafely(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new LocalServerError(
      data,
      "Tailored Marketplace message generation failed."
    );
  }

  const message =
    String(
      data.message || ""
    ).trim();

  if (!message) {
    throw new Error(
      "AI returned an empty Marketplace message."
    );
  }

  return message;
}

function getMarketplaceMessageInputText(
  input
) {
  if (!input) {
    return "";
  }

  if (
    input instanceof HTMLInputElement ||
    input instanceof HTMLTextAreaElement
  ) {
    return String(
      input.value || ""
    );
  }

  if (input.isContentEditable) {
    return String(
      input.textContent || ""
    );
  }

  return "";
}


async function waitForMarketplaceMessageSendConfirmation({
  input,
  sentMessage,
  timeoutMs = 7000
}) {
  const startedAt =
    Date.now();

  const expected =
    String(
      sentMessage || ""
    ).trim();

  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    /*
      Facebook frequently destroys/recreates the
      composer after a successful send.
    */
    if (
      !input ||
      !document.contains(input)
    ) {
      return true;
    }

    const currentValue =
      getMarketplaceMessageInputText(
        input
      ).trim();

    /*
      Successful sends normally clear the composer
      or restore Facebook's default message.
    */
    if (
      currentValue !== expected
    ) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

async function messageMarketplaceSellerForVerifiedHit(
  result
) {
  console.log(
    "[AUTO MESSAGE] Starting seller-message check.",
    {
      pageUrl: window.location.href,
      recommendation:
        result?.recommendation || ""
    }
  );

  if (!isFacebookMarketplaceListingPage()) {
    console.warn(
      "[AUTO MESSAGE] Aborted: not on a Marketplace listing page.",
      window.location.href
    );

    return {
      sent: false,
      reason:
        "Not on a Marketplace listing page."
    };
  }

  if (!isHitRecommendation(result)) {
    console.warn(
      "[AUTO MESSAGE] Aborted: final result is not a hit.",
      result?.recommendation
    );

    return {
      sent: false,
      reason: "Final result is not a hit."
    };
  }

  const listingId =
    getFacebookMarketplaceItemId();

  const messagedIds =
    await getMessagedMarketplaceListingIds();

  if (
    listingId &&
    messagedIds.includes(listingId)
  ) {
    console.warn(
      "[AUTO MESSAGE] Aborted: listing is already marked as messaged.",
      listingId
    );

        return {
      sent: false,
      reason: "Already messaged."
    };
  }


  /*
    Generate a slightly tailored message for this hit.

    If AI generation fails for any reason, keep using
    the original generic message so auto mode continues.
  */
  let messageToSend =
    MARKETPLACE_HIT_MESSAGE;

  try {
    messageToSend =
      await generateTailoredMarketplaceHitMessage();
      
    console.log(
      "[AUTO MESSAGE] AI-tailored message:",
      messageToSend
    );
  } catch (error) {
    console.warn(
      "[AUTO MESSAGE] Tailored-message generation failed. Falling back to generic message.",
      error
    );

    messageToSend =
      MARKETPLACE_HIT_MESSAGE;
  }


  let input = null;

/*
  Facebook sometimes does not render the inline seller
  textarea until the message section is scrolled into view
  or a Message button is clicked.
*/
for (let attempt = 1; attempt <= 4; attempt += 1) {
  console.log(
    `[AUTO MESSAGE] Looking for message input, attempt ${attempt}/4.`
  );

  input = findMarketplaceSellerMessageInput();

  if (input) {
    break;
  }

  /*
    Try to open a collapsed seller-message composer.
  */
  const messageButton = Array.from(
    document.querySelectorAll(
      'button, [role="button"]'
    )
  ).find(element => {
    if (!isVisibleMarketplaceElement(element)) {
      return false;
    }

    const text = String(
      element.innerText ||
      element.textContent ||
      element.getAttribute("aria-label") ||
      ""
    )
      .trim()
      .toLowerCase();

    return (
      text === "message" ||
      text === "message seller" ||
      text.includes("send seller a message")
    );
  });

  if (messageButton) {
    console.log(
      "[AUTO MESSAGE] Clicking Message button to reveal composer."
    );

    messageButton.click();
    await sleep(1200);
  }

  /*
    Move through the listing details panel so lazy-loaded
    message controls have an opportunity to render.
  */
  window.scrollBy({
    top: Math.round(window.innerHeight * 0.65),
    behavior: "smooth"
  });

  await sleep(1500);

  /*
    Also accept a matching textarea that exists in the DOM
    even if Facebook currently reports a zero-size rectangle.
  */
  input =
    findMarketplaceSellerMessageInput() ||
    document.querySelector(
      'textarea[data-interactable*="keyup"]'
    ) ||
    Array.from(
      document.querySelectorAll("textarea")
    ).find(element => {
      const value = String(
        element.value ||
        element.textContent ||
        ""
      ).toLowerCase();

      return value.includes(
        "is this available"
      );
    }) ||
    null;

  if (input) {
    break;
  }

  await sleep(1000);
}

if (!input) {
  console.warn(
    "[AUTO MESSAGE] Could not find seller message input after opening and scrolling.",
    {
      textareaCount:
        document.querySelectorAll(
          "textarea"
        ).length,

      interactableTextareaCount:
        document.querySelectorAll(
          'textarea[data-interactable]'
        ).length,

      visibleButtons: Array.from(
        document.querySelectorAll(
          'button, [role="button"]'
        )
      )
        .filter(
          isVisibleMarketplaceElement
        )
        .map(element =>
          String(
            element.innerText ||
            element.textContent ||
            element.getAttribute(
              "aria-label"
            ) ||
            ""
          ).trim()
        )
        .filter(Boolean)
        .slice(0, 30)
    }
  );

  return {
    sent: false,
    reason: "Message input not found."
  };
}

input.scrollIntoView({
  block: "center",
  inline: "nearest"
});

await sleep(500);

console.log(
  "[AUTO MESSAGE] Found seller message input.",
  input
);

  console.log(
    "[AUTO MESSAGE] Found message input.",
    input
  );

    setMarketplaceMessageInputValue(
    input,
    messageToSend
  );
  await sleep(1200);

  const actualValue =
    input instanceof HTMLInputElement ||
    input instanceof HTMLTextAreaElement
      ? input.value
      : input.textContent;

  console.log(
    "[AUTO MESSAGE] Input value after insertion:",
    actualValue
  );

   if (
    String(actualValue || "").trim() !==
    messageToSend.trim()
  ) {
    console.warn(
      "[AUTO MESSAGE] Facebook did not retain the intended message.",
      {
        expected: messageToSend,
        actual: actualValue
      }
    );

    return {
      sent: false,
      reason:
        "Facebook did not retain the inserted message."
    };
  }

  const sendButton =
    await waitForMarketplaceElement(
      () =>
        findMarketplaceSellerSendButton(
          input
        ),
      8000
    );

  if (!sendButton) {
    console.warn(
      "[AUTO MESSAGE] Could not find Send button."
    );

    return {
      sent: false,
      reason: "Send button not found."
    };
  }

  console.log(
    "[AUTO MESSAGE] Found Send button.",
    sendButton
  );

  const ariaDisabled =
    sendButton.getAttribute(
      "aria-disabled"
    ) === "true";

  if (
    sendButton.disabled ||
    ariaDisabled
  ) {
    console.warn(
      "[AUTO MESSAGE] Send button is disabled.",
      {
        disabled:
          Boolean(sendButton.disabled),
        ariaDisabled
      }
    );

    return {
      sent: false,
      reason: "Send button disabled."
    };
  }

  sendButton.scrollIntoView({
    block: "center",
    inline: "nearest"
  });

  sendButton.focus();

  sendButton.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      view: window
    })
  );

  sendButton.dispatchEvent(
    new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      view: window
    })
  );

  sendButton.click();

console.log(
  "[AUTO MESSAGE] Send button clicked. Waiting for Facebook confirmation...",
  listingId
);

const sendConfirmed =
  await waitForMarketplaceMessageSendConfirmation({
    input,
    sentMessage:
      messageToSend,
    timeoutMs:
      7000
  });

if (!sendConfirmed) {
  console.warn(
    "[AUTO MESSAGE] Send click was not confirmed. Listing will remain eligible for retry.",
    {
      listingId,
      remainingInputValue:
        getMarketplaceMessageInputText(
          input
        )
    }
  );

  return {
    sent: false,
    reason:
      "Facebook did not confirm the message send.",
    listingId
  };
}

/*
  ONLY record the listing after Facebook's
  composer reacted to the Send action.
*/
if (listingId) {
  await markMarketplaceListingMessaged(
    listingId
  );
}

console.log(
  "[AUTO MESSAGE] Seller message confirmed:",
  listingId
);

return {
  sent: true,
  listingId
};
}

async function queueMarketplaceSellerForVerifiedHit(
  result
) {
  console.log(
    "[OUTREACH QUEUE] Starting hit queue check.",
    {
      pageUrl:
        window.location.href,

      recommendation:
        result?.recommendation || ""
    }
  );

  /*
    Only queue actual Marketplace listings.
  */
  if (!isFacebookMarketplaceListingPage()) {
    console.warn(
      "[OUTREACH QUEUE] Aborted: not on Marketplace listing page."
    );

    return {
      queued: false,
      reason:
        "Not on a Marketplace listing page."
    };
  }

  /*
    Only Buy Now / Negotiate results
    should enter the outreach queue.
  */
  if (!isHitRecommendation(result)) {
    console.log(
      "[OUTREACH QUEUE] Not a hit. Nothing queued.",
      result?.recommendation
    );

    return {
      queued: false,
      reason:
        "Final result is not a hit."
    };
  }

  const listingUrl =
    String(
      window.location.href || ""
    ).split("?")[0];

  const listingId =
    getFacebookMarketplaceItemId(
      listingUrl
    );

  if (!listingId) {
    console.warn(
      "[OUTREACH QUEUE] Could not determine listing ID.",
      listingUrl
    );

    return {
      queued: false,
      reason:
        "Could not determine Marketplace listing ID."
    };
  }

  /*
    Get current scanner session.
  */
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

  const state =
    stored[
      MARKETPLACE_AUTO_STATE_KEY
    ] || {};

  const sessionId =
    String(
      state.outreachSessionId ||
      state.sessionLog?.sessionId ||
      ""
    ).trim();

  if (!sessionId) {
    throw new Error(
      "Marketplace outreach session ID is missing."
    );
  }

  /*
    Generate exactly the same tailored message
    that the old auto-message system would have sent.
  */
  let generatedMessage =
    MARKETPLACE_HIT_MESSAGE;

  try {
    generatedMessage =
      await generateTailoredMarketplaceHitMessage();

    console.log(
      "[OUTREACH QUEUE] Generated tailored message:",
      generatedMessage
    );

  } catch (error) {
    console.warn(
      "[OUTREACH QUEUE] Tailored generation failed. Using fallback.",
      error
    );

    generatedMessage =
      MARKETPLACE_HIT_MESSAGE;
  }

  /*
    Send the prepared outreach job to the server.

    IMPORTANT:
    This does NOT touch Facebook's message box.
    It only stores the work for Extension B.
  */
  const response =
    await fetchLocalServer(
      "/marketplace-outreach/queue",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            sessionId,

            listingId,

            listingUrl,

            message:
              generatedMessage,

            recommendation:
              result?.recommendation || "",

            createdAt:
              Date.now()
          })
      },
      {
        timeoutMs: 10000,
        retries: 1
      }
    );

  const data =
    await readJsonSafely(
      response
    );

if (
  !response.ok ||
  data?.ok !== true ||
  data?.error
) {
  throw new LocalServerError(
    data,
    "Could not save Marketplace hit to outreach queue."
  );
}

/*
  Server rejected this as a duplicate.

  Do NOT increment outreachQueued.
*/
if (
  data?.duplicate === true ||
  data?.queued === false
) {
  console.log(
    "[OUTREACH QUEUE] Listing already exists in outreach queue:",
    {
      listingId,
      listingUrl,
      existingItem:
        data?.item || null
    }
  );

  return {
    queued: false,
    duplicate: true,
    sessionId,
    listingId,
    listingUrl,
    message:
      generatedMessage
  };
}

console.log(
  "[OUTREACH QUEUE] Hit queued successfully:",
  {
    sessionId,
    listingId,
    listingUrl,
    message:
      generatedMessage
  }
);

  /*
    Increment scanner-session queue count.
  */
  const latestStored =
    await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

  const latestState =
    latestStored[
      MARKETPLACE_AUTO_STATE_KEY
    ];

  if (latestState?.running) {
    const currentLog =
      latestState.sessionLog || {};

    await updateMarketplaceSessionLog({
      outreachQueued:
        Number(
          currentLog.outreachQueued || 0
        ) + 1
    });
  }

  return {
    queued: true,

    sessionId,

    listingId,

    listingUrl,

    message:
      generatedMessage
  };
}



function getFacebookMarketplaceItemId(url = window.location.href) {
  const text = String(url || "");

  try {
    const parsed = new URL(text, window.location.origin);
    const match = parsed.pathname.match(/\/marketplace\/item\/(\d+)/);
    return match ? match[1] : "";
  } catch (error) {
    const match = text.match(/\/marketplace\/item\/(\d+)/);
    return match ? match[1] : "";
  }
}

async function getProcessedMarketplaceListingIds(
  candidateListingIds = []
) {
  const listingIds = [
    ...new Set(
      (
        Array.isArray(candidateListingIds)
          ? candidateListingIds
          : []
      )
        .map(value =>
          String(value || "").trim()
        )
        .filter(Boolean)
    )
  ];

  if (!listingIds.length) {
    return [];
  }

  const response =
    await fetchLocalServer(
      "/processed-marketplace-listings/check",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            listingIds
          })
      }
    );

  const data =
    await readJsonSafely(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new LocalServerError(
      data,
      "Could not check processed Marketplace listings."
    );
  }

  return Array.isArray(
    data.processedListingIds
  )
    ? data.processedListingIds
    : [];
}


async function claimMarketplaceListingId(
  listingId
) {
  const cleanListingId =
    String(
      listingId || ""
    ).trim();

  if (!cleanListingId) {
    return false;
  }

  const response =
    await fetchLocalServer(
      "/processed-marketplace-listings/claim",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            listingId:
              cleanListingId
          })
      }
    );

  const data =
    await readJsonSafely(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new LocalServerError(
      data,
      "Could not claim Marketplace listing."
    );
  }

  return data.claimed === true;
}

function shouldActivateSearchPollutionRerun(cleanupResult) {
  const invalidComps = Array.isArray(cleanupResult?.invalidComps)
    ? cleanupResult.invalidComps
    : [];

  const pollution = cleanupResult?.searchPollution || {};

  const removedByAiCleanup = invalidComps.length;

  const validExactModelCount = Number(
    pollution.validExactModelCount ?? cleanupResult?.validIndexes?.length ?? 0
  );

  const relatedWrongModelCount = Number(
    pollution.relatedWrongModelCount ?? 0
  );

  const pollutedByRelatedModels =
    pollution.pollutedByRelatedModels === true;

  const relatedModelsOverwhelming =
    pollutedByRelatedModels &&
    relatedWrongModelCount > validExactModelCount;

  return {
    shouldRerun:
      removedByAiCleanup >= 45 &&
      relatedModelsOverwhelming,

    removedByAiCleanup,
    validExactModelCount,
    relatedWrongModelCount,
    pollutedByRelatedModels,
    relatedModelsOverwhelming
  };
}

async function saveSessionListingClicked({
  facebookUrl,
  listingId,
  title,
  sourceText
}) {
  const stored = await chrome.storage.local.get(SESSION_LISTINGS_KEY);

  const existing = Array.isArray(stored[SESSION_LISTINGS_KEY])
    ? stored[SESSION_LISTINGS_KEY]
    : [];

  const cleanUrl = String(facebookUrl || "").split("?")[0];
  const cleanListingId = listingId || getFacebookMarketplaceItemId(cleanUrl);

  const entry = {
    id: cleanListingId || `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    listingId: cleanListingId,
    facebookUrl: cleanUrl,
    title: title || "",
    sourceText: sourceText || "",
    clickedAt: new Date().toISOString(),
    recommendation: "",
    reason: "",
    facebookPrice: null,
    estimatedResaleValue: null,
    profitAtAsk: null,
    profitAt35: null,
    maxBuyPrice: null,
    result: null
  };

  const withoutDuplicate = existing.filter(saved => {
    if (cleanListingId) return saved.listingId !== cleanListingId;
    return saved.facebookUrl !== cleanUrl;
  });

  await chrome.storage.local.set({
    [SESSION_LISTINGS_KEY]: [entry, ...withoutDuplicate]
  });

  console.log("Saved clicked listing to session library:", entry);
}

async function updateSessionListingResult(finalResult) {
    if (!(await isLibrarySavingEnabled())) {
    return;
  }
  const stored = await chrome.storage.local.get([
    SESSION_LISTINGS_KEY,
    MARKETPLACE_AUTO_STATE_KEY
  ]);

  const library = Array.isArray(stored[SESSION_LISTINGS_KEY])
    ? stored[SESSION_LISTINGS_KEY]
    : [];

  const state = stored[MARKETPLACE_AUTO_STATE_KEY] || {};

  const currentUrl =
    state.currentListingUrl ||
    getCurrentFacebookListingUrl().split("?")[0];

  const listingId = getFacebookMarketplaceItemId(currentUrl);

  const updatedLibrary = library.map(entry => {
    const sameListing =
      (listingId && entry.listingId === listingId) ||
      (currentUrl && entry.facebookUrl === currentUrl);

    if (!sameListing) return entry;

    return {
      ...entry,
      title:
        entry.title ||
        finalResult?.targetProduct ||
        finalResult?.title ||
        "",
      recommendation: finalResult?.recommendation || "",
      reason: finalResult?.reason || "",
      facebookPrice: finalResult?.facebookPrice ?? entry.facebookPrice ?? null,
      estimatedResaleValue:
        finalResult?.totalExpectedSalePrice ??
        finalResult?.expectedSalePrice ??
        entry.estimatedResaleValue ??
        null,
      profitAtAsk: finalResult?.profitAtAsk ?? entry.profitAtAsk ?? null,
      profitAt35: finalResult?.profitAt35 ?? entry.profitAt35 ?? null,
      maxBuyPrice: finalResult?.maxBuyPrice ?? entry.maxBuyPrice ?? null,
      result: finalResult || null,
      analyzedAt: new Date().toISOString()
    };
  });

  await chrome.storage.local.set({
    [SESSION_LISTINGS_KEY]: updatedLibrary
  });

  console.log("Updated session listing result:", {
    listingId,
    currentUrl,
    recommendation: finalResult?.recommendation
  });
}

async function clearSessionListingsLibrary() {
  const confirmed = confirm(
    "Clear all session listings?\n\nThis cannot be undone."
  );

  if (!confirmed) return;

  await chrome.storage.local.set({
    [SESSION_LISTINGS_KEY]: []
  });

  console.log("Session listings library cleared.");

  await showSessionListingsLibrary();
}

async function saveScamListing({
  context,
  result
}) {
  if (!(await isLibrarySavingEnabled())) {
    return;
  }

  const stored = await chrome.storage.local.get(
    SCAM_LISTINGS_KEY
  );

  const existing = Array.isArray(
    stored[SCAM_LISTINGS_KEY]
  )
    ? stored[SCAM_LISTINGS_KEY]
    : [];

  const facebookUrl =
    context?.facebookUrl ||
    getCurrentFacebookListingUrl().split("?")[0];

  const listingId =
    getFacebookMarketplaceItemId(facebookUrl);

  const entry = {
    id:
      listingId ||
      `${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}`,

    listingId,

    title:
      context?.originalFacebookTitle ||
      result?.title ||
      "",

    description:
      context?.facebookDescription ||
      "",

    facebookUrl,

    facebookPrice:
      result?.facebookPrice ??
      context?.facebookPrice ??
      null,

    estimatedResaleValue:
      result?.totalExpectedSalePrice ??
      result?.expectedSalePrice ??
      null,

    resaleToAskRatio:
      result?.resaleToAskRatio ??
      null,

    maxResaleToAskRatio:
      result?.maxResaleToAskRatio ??
      2.5,

    recommendation:
      result?.recommendation ||
      "Scam",

    reason:
      result?.reason ||
      "Listing exceeded the scam-value threshold.",

    items:
      Array.isArray(result?.items)
        ? result.items
        : [],

    ignoredItems:
      result?.ignoredItems ||
      context?.ignoredItems ||
      [],

    savedAt: Date.now(),

    rawResult:
      result || null
  };

  const withoutDuplicate =
    existing.filter(saved => {
      if (listingId) {
        return saved.listingId !== listingId;
      }

      return saved.facebookUrl !== facebookUrl;
    });

  const updatedLibrary = [
    entry,
    ...withoutDuplicate
  ].slice(0, 250);

  await chrome.storage.local.set({
    [SCAM_LISTINGS_KEY]: updatedLibrary
  });

  console.log(
    "Saved scam Marketplace listing:",
    entry
  );
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isFacebookMarketplaceListPage() {
  return (
    window.location.hostname.includes("facebook.com") &&
    window.location.href.includes("/marketplace") &&
    !window.location.href.includes("/marketplace/item/")
  );
}

function isFacebookMarketplaceListingPage() {
  return (
    window.location.hostname.includes("facebook.com") &&
    window.location.href.includes("/marketplace/item/")
  );
}

function getVisibleMarketplaceListingLinks() {
  const links = Array.from(document.querySelectorAll("a[href*='/marketplace/item/']"));

  const cleaned = links
    .map(link => {
      const href = link.href.split("?")[0];

      const img = link.querySelector("img");
      const linkRect = link.getBoundingClientRect();
      const imgRect = img ? img.getBoundingClientRect() : null;

      const rect =
        imgRect && imgRect.width > 40 && imgRect.height > 40
          ? imgRect
          : linkRect;

     return {
  el: link,
  href,
  fullHref: link.href,
  listingId: getFacebookMarketplaceItemId(href),
  rect,
  text: link.innerText || ""
};
    })
    .filter(item => item.href)
    .filter(item => item.href.includes("/marketplace/item/"))
    .filter(item => item.rect.width > 40 || item.rect.height > 40)
    .filter(item => item.rect.top > 60)
    .filter(item => item.rect.top < window.innerHeight + 300)
    .sort((a, b) => {
      if (Math.abs(a.rect.top - b.rect.top) > 20) {
        return a.rect.top - b.rect.top;
      }
      return a.rect.left - b.rect.left;
    });

  const seen = new Set();

  const unique = cleaned.filter(item => {
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });

  console.log("Visible Marketplace listing links found:", unique.length, unique.map(item => item.href));

  return unique;
}

async function startMarketplaceAutoAnalyzer(
  minutesToRun = null,
  options = {}
) {
  const serverIsRunning =
    await isLocalServerRunning();

  if (!serverIsRunning) {
    alert(
      "The local analysis server is not running.\n\n" +
      "Start the server at http://127.0.0.1:3000, then try the scan again."
    );

    return;
  }

  if (!isFacebookMarketplaceListPage()) {
    alert(
      "Start this from a Facebook Marketplace listing/search results page."
    );
    return;
  }

  /*
  Start every scanner session with a clean
  in-memory pipeline registry.

  Jobs from a previous stopped/crashed session
  must never block a new scan.
*/
await clearMarketplaceAnalysisJobRegistry();

console.log(
  "[PIPELINE] Cleared stale analysis jobs and finish lock."
);

  const now = Date.now();

  const durationMinutes =
    Number(minutesToRun);

  const hasTimer =
    Number.isFinite(durationMinutes) &&
    durationMinutes > 0;

  const scanMode =
    options.scanMode ===
    MARKETPLACE_RANDOM_KEYWORD_MODE
      ? MARKETPLACE_RANDOM_KEYWORD_MODE
      : "standard";

  const currentSearchTerm =
    getMarketplaceSearchTermFromUrl(
      window.location.href
    );

  const outreachSessionId =
  createMarketplaceOutreachSessionId();

const state = {
  running: true,

  outreachSessionId,

  scanMode,

  listUrl: window.location.href,

    processedListingUrls: [],
    currentListingUrl: "",

    waitingForAnalysis: false,
    analysisDone: false,
    lastResult: null,

    createdAt: now,

    stopAt: hasTimer
      ? now +
        durationMinutes *
          60 *
          1000
      : null,

    timerMinutes: hasTimer
      ? durationMinutes
      : null,

    /*
      Random-keyword search tracking.
    */
    currentSearchTerm,
    previousSearchTerm: "",

    usedSearchTerms:
      scanMode ===
      MARKETPLACE_RANDOM_KEYWORD_MODE
        ? [currentSearchTerm].filter(
            Boolean
          )
        : [],

    searchStartedAt: now,
    searchSwitchCount: 0,

    /*
      This is only set after the results page fails
      to produce an unprocessed listing.
    */
    noFreshListingSince: null,

    /*
      Reset whenever a fresh listing is opened.
    */
    lastFreshListingOpenedAt: now,

    sessionLog: {
  sessionId: outreachSessionId,
  startedAt: now,
  clickedListings: 0,
  hitsFound: 0,
  outreachQueued: 0
}
  };

  await chrome.storage.local.set({
    [MARKETPLACE_AUTO_STATE_KEY]:
      state
  });

  try {
  const response =
    await fetchLocalServer(
      "/marketplace-outreach/session/start",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            sessionId:
              outreachSessionId,

            startedAt:
              now,

            listUrl:
              window.location.href,

            scanMode
          })
      },
      {
        timeoutMs: 10000,
        retries: 1
      }
    );

  const data =
    await readJsonSafely(
      response
    );

  if (
    !response.ok ||
    data?.error
  ) {
    console.warn(
      "[OUTREACH QUEUE] Could not start server session:",
      data
    );
  } else {
    console.log(
      "[OUTREACH QUEUE] Server session started:",
      outreachSessionId
    );
  }

} catch (error) {
  console.warn(
    "[OUTREACH QUEUE] Could not create server session:",
    error
  );
}

  await refreshMarketplaceAutoStatsPanel();

  console.log(
    hasTimer
      ? (
          scanMode ===
          MARKETPLACE_RANDOM_KEYWORD_MODE
            ? `Random Keyword Scan started for ${durationMinutes} minute(s).`
            : `Auto analyzer started for ${durationMinutes} minute(s).`
        )
      : (
          scanMode ===
          MARKETPLACE_RANDOM_KEYWORD_MODE
            ? "Random Keyword Scan started with no timer."
            : "Auto analyzer started with no timer."
        )
  );

  await openNextMarketplaceListing();
}

async function stopMarketplaceAutoAnalyzer(options = {}) {
  const stored = await chrome.storage.local.get(MARKETPLACE_AUTO_STATE_KEY);
  const state = stored[MARKETPLACE_AUTO_STATE_KEY] || {};

  const sessionLog = state.sessionLog || {};
  const startedAt = sessionLog.startedAt || state.createdAt || Date.now();
  const endedAt = Date.now();

  const duration = formatSessionDuration(endedAt - startedAt);
  const clickedListings = sessionLog.clickedListings || 0;
  const hitsFound = sessionLog.hitsFound || 0;
  const stopReason = options.reason || "Manual stop";

  const outreachSessionId =
  String(
    state.outreachSessionId ||
    sessionLog.sessionId ||
    ""
  ).trim();

const outreachQueued =
  Number(
    sessionLog.outreachQueued || 0
  );

  await chrome.storage.local.set({
    [MARKETPLACE_AUTO_STATE_KEY]: {
      ...state,
      running: false,
      waitingForAnalysis: false,
      analysisDone: false,
      currentListingUrl: "",
      stoppedAt: Date.now(),
      stopReason
    }
  });

 console.log("Marketplace auto analyzer stopped.");

if (outreachSessionId) {
  try {
    const finalizeResponse =
      await fetchLocalServer(
        "/marketplace-outreach/session/finalize",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              sessionId:
                outreachSessionId,

              endedAt,

              stopReason,

              clickedListings,

              hitsFound,

              outreachQueued
            })
        },
        {
          timeoutMs: 10000,
          retries: 1
        }
      );

    const finalizeData =
      await readJsonSafely(
        finalizeResponse
      );

    if (
      !finalizeResponse.ok ||
      finalizeData?.error
    ) {
      console.warn(
        "[OUTREACH QUEUE] Session finalization failed:",
        finalizeData
      );
    } else {
      console.log(
        "[OUTREACH QUEUE] Session finalized:",
        finalizeData
      );
    }

  } catch (error) {
    console.warn(
      "[OUTREACH QUEUE] Could not finalize outreach session:",
      error
    );
  }
}

await refreshMarketplaceAutoStatsPanel();

alert(
  `Auto session stopped.\n\n` +
  `Reason: ${stopReason}\n` +
  `Session length: ${duration}\n` +
  `Listings clicked through: ${clickedListings}\n` +
  `Hits found: ${hitsFound}\n` +
  `Outreach queued: ${outreachQueued}\n\n` +
  `Outreach session:\n${outreachSessionId || "None"}`
);
}
async function updateMarketplaceSessionLog(updates = {}) {
  const stored = await chrome.storage.local.get(MARKETPLACE_AUTO_STATE_KEY);
  const state = stored[MARKETPLACE_AUTO_STATE_KEY];

  if (!state) return;

  const currentLog = state.sessionLog || {
    startedAt: Date.now(),
    clickedListings: 0,
    hitsFound: 0
  };

  await chrome.storage.local.set({
    [MARKETPLACE_AUTO_STATE_KEY]: {
      ...state,
      sessionLog: {
        ...currentLog,
        ...updates
      }
    }
  });
}

async function openNextMarketplaceListing() {
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

  let state =
    stored[MARKETPLACE_AUTO_STATE_KEY];

  if (!state?.running) return;

await pruneStaleMarketplaceAnalysisJobs();

const activeAnalysisJobCount =
  await countActiveMarketplaceAnalysisJobs();


if (
  activeAnalysisJobCount >=
  MAX_CONCURRENT_MARKETPLACE_ANALYSES
) {
  console.log(
    "[MARKETPLACE BROWSE] Maximum concurrent listing jobs reached. Waiting for capacity:",
    activeAnalysisJobCount
  );

  await waitForMarketplaceChildListingToFinish();

  return;
}

  if (
    !(await isMarketplaceAutoAnalyzerRunning())
  ) {
    return;
  }

  let links =
    getVisibleMarketplaceListingLinks();

  let waitAttempts = 0;

  while (
    !links.length &&
    waitAttempts < 8
  ) {
    console.log(
      "Waiting for Marketplace listings to load..."
    );

    await sleep(1000);

    if (
      !(await isMarketplaceAutoAnalyzerRunning())
    ) {
      console.log(
        "Auto analyzer stopped while waiting for listings."
      );

      return;
    }

    links =
      getVisibleMarketplaceListingLinks();

    waitAttempts += 1;
  }

const processedListingIds =
  await getProcessedMarketplaceListingIds(
    links.map(
      link =>
        link.listingId
    )
  );

let next = links.find(link => {
  return (
    link.listingId &&
    !processedListingIds.includes(
      link.listingId
    )
  );
});

  let scrollAttempts = 0;

  while (
    !next &&
    scrollAttempts < 10
  ) {
    /*
      Start the 30-second exhaustion timer only
      after the results page cannot produce a fresh
      visible listing.
    */
    if (
      state.scanMode ===
        MARKETPLACE_RANDOM_KEYWORD_MODE &&
      !state.noFreshListingSince
    ) {
      state = {
        ...state,
        noFreshListingSince:
          Date.now()
      };

      await chrome.storage.local.set({
        [MARKETPLACE_AUTO_STATE_KEY]:
          state
      });

      console.log(
        "[KEYWORD EXHAUSTION TIMER STARTED]",
        {
          term:
            state.currentSearchTerm ||
            getMarketplaceSearchTermFromUrl(),
          delayMs:
            MARKETPLACE_SEARCH_EXHAUSTION_DELAY_MS
        }
      );
    }

    console.log(
      "No unprocessed visible listing found. Scrolling for more listings..."
    );

    window.scrollBy({
      top: Math.round(
        window.innerHeight * 0.9
      ),
      behavior: "smooth"
    });

    await sleep(
      randomInt(1800, 3200)
    );

    if (
      !(await isMarketplaceAutoAnalyzerRunning())
    ) {
      console.log(
        "Auto analyzer stopped while scrolling for listings."
      );

      return;
    }

    links =
      getVisibleMarketplaceListingLinks();

const latestProcessedListingIds =
  await getProcessedMarketplaceListingIds(
    links.map(
      link =>
        link.listingId
    )
  );

    next = links.find(link => {
      return (
        link.listingId &&
        !latestProcessedListingIds.includes(
          link.listingId
        )
      );
    });

    console.log(
      `Scroll attempt ${scrollAttempts + 1}: ` +
      `found ${links.length} visible listing link(s).`
    );

    /*
      A fresh listing appeared. Clear the exhaustion
      timer before opening it.
    */
    if (next) {
      const latestStored =
        await chrome.storage.local.get(
          MARKETPLACE_AUTO_STATE_KEY
        );

      const latestState =
        latestStored[
          MARKETPLACE_AUTO_STATE_KEY
        ];

      if (latestState?.running) {
        state = {
          ...latestState,
          noFreshListingSince: null
        };

        await chrome.storage.local.set({
          [MARKETPLACE_AUTO_STATE_KEY]:
            state
        });
      }

      break;
    }

    /*
      Random Keyword Scan only:
      switch terms after 30 seconds without finding
      an unprocessed listing.
    */
    if (
      state.scanMode ===
      MARKETPLACE_RANDOM_KEYWORD_MODE
    ) {
      const latestStored =
        await chrome.storage.local.get(
          MARKETPLACE_AUTO_STATE_KEY
        );

      state =
        latestStored[
          MARKETPLACE_AUTO_STATE_KEY
        ] || state;

      const noFreshListingSince =
        Number(
          state.noFreshListingSince || 0
        );

      const exhaustedForMs =
        noFreshListingSince
          ? Date.now() -
            noFreshListingSince
          : 0;

      console.log(
        "[KEYWORD EXHAUSTION CHECK]",
        {
          term:
            state.currentSearchTerm ||
            getMarketplaceSearchTermFromUrl(),
          exhaustedForMs,
          requiredMs:
            MARKETPLACE_SEARCH_EXHAUSTION_DELAY_MS
        }
      );

      if (
        exhaustedForMs >=
        MARKETPLACE_SEARCH_EXHAUSTION_DELAY_MS
      ) {
        await switchToRandomMarketplaceSearchTerm(
          `No unprocessed listing was found for ` +
          `${Math.round(
            exhaustedForMs / 1000
          )} seconds.`
        );

        return;
      }
    }

    scrollAttempts += 1;
  }

  if (!next) {
    /*
      The standard Auto Scan retains its current
      behavior.
    */
    if (
      state.scanMode !==
      MARKETPLACE_RANDOM_KEYWORD_MODE
    ) {
      console.log(
        "No new Marketplace listings found. Waiting, scrolling more, then retrying."
      );

      window.scrollBy({
        top: Math.round(
          window.innerHeight * 2
        ),
        behavior: "smooth"
      });

      await sleep(
        randomInt(8000, 12000)
      );

      if (
        !(await isMarketplaceAutoAnalyzerRunning())
      ) {
        return;
      }

      await openNextMarketplaceListing();
      return;
    }

    /*
      Random Keyword Scan:
      ten scrolls can sometimes finish before the
      full 30-second threshold. Wait only for the
      remaining portion, then make one final check.
    */
    const latestStored =
      await chrome.storage.local.get(
        MARKETPLACE_AUTO_STATE_KEY
      );

    state =
      latestStored[
        MARKETPLACE_AUTO_STATE_KEY
      ] || state;

    const startedAt =
      Number(
        state.noFreshListingSince ||
        Date.now()
      );

    const elapsedMs =
      Date.now() - startedAt;

    const remainingMs =
      Math.max(
        0,
        MARKETPLACE_SEARCH_EXHAUSTION_DELAY_MS -
          elapsedMs
      );

    if (remainingMs > 0) {
      console.log(
        `[KEYWORD EXHAUSTION WAIT] ` +
        `Waiting ${remainingMs}ms before final check.`
      );

      await sleep(remainingMs);
    }

    if (
      !(await isMarketplaceAutoAnalyzerRunning())
    ) {
      return;
    }

    /*
      Give Facebook one final opportunity to load
      more cards before switching.
    */
    window.scrollBy({
      top: Math.round(
        window.innerHeight * 1.5
      ),
      behavior: "smooth"
    });

    await sleep(
      randomInt(1800, 2600)
    );

    const finalLinks =
      getVisibleMarketplaceListingLinks();

      const finalProcessedIds =
  await getProcessedMarketplaceListingIds(
    finalLinks.map(
      link =>
        link.listingId
    )
  );

next = finalLinks.find(link => {
      return (
        link.listingId &&
        !finalProcessedIds.includes(
          link.listingId
        )
      );
    });

    if (!next) {
      await switchToRandomMarketplaceSearchTerm(
        "No unprocessed listing appeared during the 30-second exhaustion window."
      );

      return;
    }
  }

  await sleep(
    randomInt(600, 1200)
  );

  if (
    !(await isMarketplaceAutoAnalyzerRunning())
  ) {
    console.log(
      "Auto analyzer stopped before opening selected listing."
    );

    return;
  }

  /*
    Re-read state to avoid overwriting changes made
    while scrolling.
  */
  const latestStored =
    await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

  const latestState =
    latestStored[
      MARKETPLACE_AUTO_STATE_KEY
    ] || state;

  const openedAt = Date.now();

  const updatedState = {
    ...latestState,

    listUrl:
      latestState.listUrl ||
      window.location.href,

    currentListingUrl:
      next.href,

    waitingForAnalysis: false,
    analysisDone: false,
    lastResult: null,

    /*
      A fresh listing has been found, so reset the
      keyword exhaustion timer.
    */
    noFreshListingSince: null,
    lastFreshListingOpenedAt:
      openedAt
  };

  await chrome.storage.local.set({
    [MARKETPLACE_AUTO_STATE_KEY]:
      updatedState
  });

  console.log(
    "Opening next Marketplace listing:",
    next.fullHref
  );

  const freshStored =
    await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

  const freshState =
    freshStored[
      MARKETPLACE_AUTO_STATE_KEY
    ];

  const currentLog =
    freshState?.sessionLog || {
      startedAt: Date.now(),
      clickedListings: 0,
      hitsFound: 0
    };

  await updateMarketplaceSessionLog({
    clickedListings:
      currentLog.clickedListings + 1
  });

  await saveSessionListingClicked({
    facebookUrl: next.href,
    listingId: next.listingId,
    title: "",
    sourceText: next.text || ""
  });

 const claimed =
  await claimMarketplaceListingId(
    next.listingId
  );

if (!claimed) {
  console.log(
    "[AUTO SCAN] Listing was claimed by another device. Finding another listing:",
    next.listingId
  );

  await openNextMarketplaceListing();

  return;
}

const openResult =
  await openMarketplaceListingInNewTab(
    next.fullHref
  );

console.log(
  "[MARKETPLACE TAB] Listing opened in independent tab:",
  {
    listingId:
      next.listingId,

    url:
      next.fullHref,

    tabId:
      openResult?.tabId
  }
);


/*
  IMPORTANT:

  The browse tab stays exactly where it is.

  Wait here until the listing tab finishes and
  clears currentListingUrl from shared auto state.
*/
await waitForMarketplaceChildListingToFinish();
}

async function waitForMarketplaceChildListingToFinish() {
  console.log(
    "[MARKETPLACE BROWSE] Watching active listing jobs..."
  );

  while (true) {
    await sleep(
      750
    );

    const stored =
      await chrome.storage.local.get(
        MARKETPLACE_AUTO_STATE_KEY
      );

    const state =
      stored[
        MARKETPLACE_AUTO_STATE_KEY
      ];


    if (
      !state?.running
    ) {
      console.log(
        "[MARKETPLACE BROWSE] Scanner stopped."
      );

      return;
    }


    /*
      Recover child tabs that died without updating
      their job status.
    */
    await pruneStaleMarketplaceAnalysisJobs();


    const jobs =
      await getMarketplaceAnalysisJobs();


    const activeJobs =
      jobs.filter(
        job =>
          !isMarketplaceAnalysisJobTerminal(
            job
          )
      );


    const parkedJobs =
      activeJobs.filter(
        job =>
          String(
            job?.status || ""
          ) ===
            "waiting-dataforseo"
      );


    /*
      DataForSEO is the ONLY point where we deliberately
      allow another listing to be opened.
    */
    if (
      parkedJobs.length > 0 &&
      activeJobs.length <
        MAX_CONCURRENT_MARKETPLACE_ANALYSES
    ) {
      console.log(
        "[MARKETPLACE BROWSE] DataForSEO wait detected. Opening another listing."
      );

      await sleep(
        randomInt(
          1000,
          2500
        )
      );

      if (
        !(await isMarketplaceAutoAnalyzerRunning())
      ) {
        return;
      }

      await openNextMarketplaceListing();

      return;
    }


    /*
      All jobs finished.
    */
    if (
      activeJobs.length === 0
    ) {
      console.log(
        "[MARKETPLACE BROWSE] All active listing jobs finished."
      );

      await sleep(
        randomInt(
          5000,
          10000
        )
      );

      if (
        !(await isMarketplaceAutoAnalyzerRunning())
      ) {
        return;
      }

      await openNextMarketplaceListing();

      return;
    }


    /*
      Both analysis slots are currently occupied.

      Do not open a third listing. The stale-job
      watchdog above still runs every 750ms.
    */
    if (
      activeJobs.length >=
      MAX_CONCURRENT_MARKETPLACE_ANALYSES
    ) {
      continue;
    }


    /*
      A normal foreground listing is still running.
    */
    if (
      String(
        state.currentListingUrl ||
        ""
      ).trim()
    ) {
      continue;
    }


    /*
      These are VALID background states.

      In particular, resume-ready and finishing must
      NOT be treated as orphaned simply because the
      DataForSEO listing cleared currentListingUrl.
    */
    const legitimateBackgroundJobs =
      activeJobs.filter(
        job =>
          isMarketplaceBackgroundAnalysisJob(
            job
          )
      );

    if (
      legitimateBackgroundJobs.length ===
      activeJobs.length
    ) {
      continue;
    }


    /*
      Actual orphan recovery.

      Give status transitions 90 seconds before
      declaring the foreground job dead.
    */
    const now =
      Date.now();

    const orphanedJobs =
      activeJobs.filter(
        job =>
          !isMarketplaceBackgroundAnalysisJob(
            job
          ) &&
          now -
            getMarketplaceAnalysisJobLastActivityAt(
              job
            ) >=
            MARKETPLACE_ORPHAN_GRACE_MS
      );


    if (
      orphanedJobs.length === 0
    ) {
      continue;
    }


    console.warn(
      "[MARKETPLACE BROWSE] Orphaned job(s) detected:",
      orphanedJobs
    );


    for (
      const job of orphanedJobs
    ) {
      await failMarketplaceAnalysisJobById(
        job.jobId,
        "Job remained active after losing its foreground Marketplace slot.",
        "orphaned"
      );

      const lockStored =
        await chrome.storage.local.get(
          MARKETPLACE_FINISH_LOCK_KEY
        );

      if (
        lockStored[
          MARKETPLACE_FINISH_LOCK_KEY
        ] ===
          job.jobId
      ) {
        await chrome.storage.local.remove(
          MARKETPLACE_FINISH_LOCK_KEY
        );
      }
    }


    await sleep(
      randomInt(
        1000,
        2000
      )
    );


    if (
      !(await isMarketplaceAutoAnalyzerRunning())
    ) {
      return;
    }


    await openNextMarketplaceListing();

    return;
  }
}

async function resumeMarketplaceAutoAnalyzerIfNeeded() {
  try {
    const stored = await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

    const state = stored[MARKETPLACE_AUTO_STATE_KEY];

    if (!state?.running) {
      return;
    }

if (isFacebookMarketplaceListingPage()) {
  /*
    IMPORTANT:

    A finished analysis must be consumed before we
    consider starting another analysis.

    This also recovers correctly if the content script
    was restarted after the eBay tab finished.
  */
  if (
    state.analysisDone ||
    state.waitingForAnalysis
  ) {
    await waitForMarketplaceAnalysisToFinish();
    return;
  }

  const waitBeforeClickMs =
    randomInt(
      1000,
      3000
    );

      console.log(
        `Auto analyzer waiting ${waitBeforeClickMs}ms before clicking AI button...`
      );

      await sleep(waitBeforeClickMs);

      if (!(await isMarketplaceAutoAnalyzerRunning())) {
        console.log(
          "Auto analyzer stopped before clicking AI button."
        );
        return;
      }

      const button = document.getElementById(
        "ebay-comp-checker-btn"
      );

      if (!button) {
        console.warn(
          "AI Check eBay Sold button not found."
        );
        return;
      }

      await chrome.storage.local.set({
        [MARKETPLACE_AUTO_STATE_KEY]: {
          ...state,
          waitingForAnalysis: true,
          analysisDone: false
        }
      });

      await refreshMarketplaceAutoStatsPanel();

      console.log(
        "Auto analyzer clicking AI Check eBay Sold."
      );

      button.click();

      await waitForMarketplaceAnalysisToFinish();
      return;
    }

    if (isFacebookMarketplaceListPage()) {
      const waitBeforeNextMs = randomInt(5000, 10000);

      console.log(
        `Auto analyzer back on list page. Waiting ${waitBeforeNextMs}ms before next listing...`
      );

      await sleep(waitBeforeNextMs);

      if (!(await isMarketplaceAutoAnalyzerRunning())) {
        console.log(
          "Auto analyzer stopped before opening next listing."
        );
        return;
      }

      await openNextMarketplaceListing();
    }
  } catch (error) {
    if (handleExtensionContextError(error)) {
      return;
    }

    throw error;
  }
}

async function openMarketplaceListingInNewTab(
  url
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      chrome.runtime.sendMessage(
        {
          type:
            "OPEN_MARKETPLACE_LISTING_TAB",

          url
        },

        response => {
          if (
            chrome.runtime.lastError
          ) {
            reject(
              new Error(
                chrome.runtime
                  .lastError
                  .message
              )
            );

            return;
          }

          if (
            !response ||
            response.ok !== true
          ) {
            reject(
              new Error(
                response?.error ||
                "Could not open Marketplace listing tab."
              )
            );

            return;
          }

          resolve(
            response
          );
        }
      );
    }
  );
}


async function closeCurrentMarketplaceListingTab() {
  return new Promise(
    resolve => {
      chrome.runtime.sendMessage(
        {
          type:
            "CLOSE_CURRENT_MARKETPLACE_LISTING_TAB"
        },

        response => {
          if (
            chrome.runtime.lastError
          ) {
            console.warn(
              "[MARKETPLACE TAB] Could not close listing tab:",
              chrome.runtime
                .lastError
                .message
            );
          }

          resolve(
            response || null
          );
        }
      );
    }
  );
}

async function closeMarketplaceAutoEbayTabs() {
  return new Promise(resolve => {
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.sendMessage
    ) {
      resolve();
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "CLOSE_MARKETPLACE_AUTO_EBAY_TABS"
      },
      response => {
        if (chrome.runtime.lastError) {
          console.warn(
            "Could not close eBay tabs:",
            chrome.runtime.lastError.message
          );
        } else {
          console.log("Closed eBay tabs after auto timeout:", response);
        }

        resolve();
      }
    );
  });
}

function getRemainingMarketplaceAutoMinutes(state) {
  if (!state?.stopAt) return null;

  const remainingMs = Math.max(0, state.stopAt - Date.now());

  if (remainingMs <= 0) return 0;

  // Round up so 24m 10s becomes 25 minutes, not 24.
  return Math.ceil(remainingMs / 60000);
}

async function waitForMarketplaceAnalysisToFinish() {

  const analysisJobId =
  getCurrentMarketplaceAnalysisJobId();
  const startedAt = Date.now();
  const maxWaitMs = 3 * 60 * 1000;

  while (true) {
    const stored = await chrome.storage.local.get(MARKETPLACE_AUTO_STATE_KEY);
    const state = stored[MARKETPLACE_AUTO_STATE_KEY];

    if (!state?.running) return;

const jobs =
  await getMarketplaceAnalysisJobs();

const currentJob =
  jobs.find(
    job =>
      job?.jobId ===
      analysisJobId
  );

if (
  currentJob?.status ===
    "complete"
) {
  const finalResult =
    currentJob.finalResult ||
    {
      recommendation:
        "Done",

      reason:
        "Analysis completed."
    };

  if (USE_SEPARATE_OUTREACH_EXTENSION) {
    /*
      MODE 1:
      Do NOT message seller here.

      Save the hit to the server so the separate
      outreach extension can handle it later.
    */
    try {
await queueMarketplaceSellerForVerifiedHit(
  finalResult
);

    } catch (queueError) {
      console.warn(
        "[OUTREACH QUEUE] Automatic hit queue failed:",
        queueError
      );

      /*
        Never silently discard a verified hit.
      */
      if (
isHitRecommendation(
  finalResult
)
      ) {
        await stopMarketplaceAutoAnalyzer({
          reason:
            "Verified Hit could not be saved to outreach queue."
        });

        return;
      }
    }

  } else {
    /*
      MODE 2:
      Message the seller immediately using this
      scanner extension.
    */
    try {
      const messageResult =
await messageMarketplaceSellerForVerifiedHit(
  finalResult
);
      console.log(
        "[DIRECT OUTREACH] Immediate outreach result:",
        messageResult
      );

    } catch (messageError) {
      console.warn(
        "[DIRECT OUTREACH] Immediate seller message failed:",
        messageError
      );
    }
  }

 /*
  queueMarketplaceSellerForVerifiedHit() may have
  updated sessionLog.outreachQueued.

  Re-read state before writing the completed-listing
  state so we do not overwrite that update.
*/
const latestStoredAfterQueue =
  await chrome.storage.local.get(
    MARKETPLACE_AUTO_STATE_KEY
  );

const latestStateAfterQueue =
  latestStoredAfterQueue[
    MARKETPLACE_AUTO_STATE_KEY
  ] || state;

const currentUrl =
  window.location.href
    .split("?")[0];


const sharedCurrentUrl =
  String(
    latestStateAfterQueue
      .currentListingUrl ||
    ""
  )
    .split("?")[0];


const updatedState = {
  ...latestStateAfterQueue,

  processedListingUrls:
    [
      ...new Set([
        ...(
          latestStateAfterQueue
            .processedListingUrls ||
          []
        ),

        currentUrl
      ])
    ],

  /*
    Only clear the shared foreground URL if THIS
    tab is still the foreground listing.

    If Listing B has already replaced it, leave B alone.
  */
  currentListingUrl:
    sharedCurrentUrl ===
      currentUrl
      ? ""
      : latestStateAfterQueue
          .currentListingUrl,

  dataForSeoListingParked:
    false
};

      await chrome.storage.local.set({
        [MARKETPLACE_AUTO_STATE_KEY]: updatedState
      });

    console.log(
  "[MARKETPLACE TAB] Analysis finished. Closing independent listing tab."
);

await sleep(
  500
);

await closeCurrentMarketplaceListingTab();

return;
    }

if (Date.now() - startedAt > maxWaitMs) {
  console.warn(
    "Timed out waiting for eBay analysis to finish."
  );

/*
  CRITICAL:

  A child listing must retry ITS OWN URL.

  state.currentListingUrl may belong to the newer
  listing while this tab is parked in DataForSEO.
*/
const currentUrl =
  String(
    window.location.href ||
    ""
  ).split("?")[0];

  const currentListingId =
    getFacebookMarketplaceItemId(
      currentUrl
    );

    const latestJobsAtTimeout =
  await getMarketplaceAnalysisJobs();

const otherActiveJobsAtTimeout =
  latestJobsAtTimeout.filter(
    job =>
      job?.jobId !==
        analysisJobId &&
      !isMarketplaceAnalysisJobTerminal(
        job
      )
  );


const latestStoredAtTimeout =
  await chrome.storage.local.get(
    MARKETPLACE_AUTO_STATE_KEY
  );

const latestStateAtTimeout =
  latestStoredAtTimeout[
    MARKETPLACE_AUTO_STATE_KEY
  ] || state;

const sharedCurrentUrlAtTimeout =
  String(
    latestStateAtTimeout
      .currentListingUrl ||
    ""
  ).split("?")[0];


/*
  Never allow an old timed-out child to reload the
  newer foreground listing or clear its shared state.
*/
if (
  (
    sharedCurrentUrlAtTimeout &&
    sharedCurrentUrlAtTimeout !==
      currentUrl
  ) ||
  otherActiveJobsAtTimeout.length > 0
) {
  const abandonedResult = {
    recommendation:
      "Error",

    reason:
      "Listing analysis timed out while another Marketplace listing was active. The stale child was abandoned instead of retrying another listing.",

    facebookPrice:
      null,

    estimatedResaleValue:
      null,

    profitAtAsk:
      null,

    profitAt35:
      null
  };


  await updateSessionListingResult(
    abandonedResult
  );


  await failMarketplaceAnalysisJobById(
    analysisJobId,
    abandonedResult.reason,
    "timeout-with-other-job"
  );


  console.warn(
    "[MARKETPLACE TAB] Abandoning stale child:",
    {
      analysisJobId,
      currentUrl,
      sharedCurrentUrlAtTimeout
    }
  );


  await closeCurrentMarketplaceListingTab();

  return;
}

  const previousRetryCount =
    await getListingAnalysisRetryCount(
      currentListingId
    );

  /*
    First timeout:
    close the old eBay tabs and rerun the entire
    Facebook listing analysis from the beginning.
  */
  if (
    currentListingId &&
    previousRetryCount <
      MAX_LISTING_ANALYSIS_RETRIES
  ) {
    const nextRetryCount =
      await incrementListingAnalysisRetryCount(
        currentListingId
      );

    console.warn(
      `Retrying complete listing analysis. ` +
      `Retry ${nextRetryCount}/` +
      `${MAX_LISTING_ANALYSIS_RETRIES}.`,
      {
        currentListingId,
        currentUrl
      }
    );

    await closeMarketplaceAutoEbayTabs();

    /*
      Delete the incomplete comp context so the
      retry cannot resume stale eBay progress.
    */
    await chrome.storage.local.remove(
      "ebayCompContext"
    );

    await chrome.storage.local.set({
      [MARKETPLACE_AUTO_STATE_KEY]: {
        ...state,

        /*
          Keep the same listing as the active listing.
        */
        currentListingUrl: currentUrl,

        /*
          On page reload, resumeMarketplaceAutoAnalyzerIfNeeded()
          will click the analysis button again.
        */
        waitingForAnalysis: false,
        analysisDone: false,

        lastResult: {
          recommendation: "Retrying",
          reason:
            `The first analysis attempt did not complete. ` +
            `Restarting the complete listing analysis ` +
            `from the beginning. Retry ` +
            `${nextRetryCount}/` +
            `${MAX_LISTING_ANALYSIS_RETRIES}.`
        },

        lastResultAt: Date.now()
      }
    });

    /*
      Reload the Marketplace listing itself.
      The auto-resume logic will start aiCheckListing()
      again after the page loads.
    */
    window.location.href = currentUrl;
    return;
  }

  /*
    Second timeout:
    the retry also failed, so record a terminal
    result and continue to the next listing.
  */
  console.error(
    "Complete listing analysis retry limit reached.",
    {
      currentListingId,
      currentUrl,
      previousRetryCount
    }
  );

  const finalTimeoutResult = {
    recommendation: "Error",
    reason:
      `The complete listing analysis failed to finish ` +
      `after the original attempt and ` +
      `${MAX_LISTING_ANALYSIS_RETRIES} retry.`,
    facebookPrice: null,
    estimatedResaleValue: null,
    profitAtAsk: null,
    profitAt35: null
  };

  /*
    Update the Session Listings card before clearing
    the current listing from auto state.
  */
  await updateSessionListingResult(
    finalTimeoutResult
  );

  await clearListingAnalysisRetryCount(
    currentListingId
  );

  await closeMarketplaceAutoEbayTabs();

  await chrome.storage.local.remove(
    "ebayCompContext"
  );

  const processedListingUrls = [
    ...(state.processedListingUrls || []),
    currentUrl
  ];

  await chrome.storage.local.set({
    [MARKETPLACE_AUTO_STATE_KEY]: {
      ...state,
      processedListingUrls: [
        ...new Set(processedListingUrls)
      ],
      currentListingUrl: "",
      waitingForAnalysis: false,
      analysisDone: false,
      lastResult: finalTimeoutResult,
      lastResultAt: Date.now()
    }
  });

console.log(
  "[MARKETPLACE TAB] Listing failed after retry limit. Closing child tab."
);

await sleep(
  500
);

await closeCurrentMarketplaceListingTab();

return;
}
  }
}

function getMarketplaceCarouselThumbnailCount() {
  const imgs = Array.from(document.querySelectorAll("img"))
    .map(img => {
      const rect = img.getBoundingClientRect();

      return {
        src: img.src || "",
        rect,
        width: rect.width,
        height: rect.height,
        area: rect.width * rect.height
      };
    })
    .filter(img => img.src.includes("fbcdn.net"))
    .filter(img => img.width >= 20 && img.width <= 80)
    .filter(img => img.height >= 20 && img.height <= 80)

    // Thumbnail strip is usually near the bottom of the main photo area,
    // not down in Today's Picks.
    .filter(img => img.rect.top > window.innerHeight * 0.55)
    .filter(img => img.rect.top < window.innerHeight - 10)

    // Keep it inside the main image column.
    .filter(img => img.rect.left > 80)
    .filter(img => img.rect.left < window.innerWidth * 0.65);

  if (!imgs.length) {
    console.log("No carousel thumbnails detected.");
    return null;
  }

  // Group thumbnails by vertical row. The real carousel thumbnails should
  // sit on almost the same y-coordinate.
  const rows = [];

  for (const img of imgs) {
    let row = rows.find(existing =>
      Math.abs(existing.top - img.rect.top) < 12
    );

    if (!row) {
      row = {
        top: img.rect.top,
        imgs: []
      };
      rows.push(row);
    }

    row.imgs.push(img);
  }

  rows.sort((a, b) => b.imgs.length - a.imgs.length);

  const bestRow = rows[0];
  const uniqueThumbs = [];

  for (const img of bestRow.imgs.sort((a, b) => a.rect.left - b.rect.left)) {
    const duplicate = uniqueThumbs.some(existing =>
      Math.abs(existing.rect.left - img.rect.left) < 8 &&
      Math.abs(existing.rect.top - img.rect.top) < 8
    );

    if (!duplicate) {
      uniqueThumbs.push(img);
    }
  }

  console.log("Carousel thumbnail candidates:", imgs);
  console.log("Best carousel thumbnail row:", uniqueThumbs);

  return uniqueThumbs.length || null;
}

async function getListingImageUrls() {
  const seen = new Set();

  /*
    Reject Facebook loading graphics, placeholders, progress indicators,
    and images contained inside loading elements.
  */
  function elementLooksLikeLoader(img) {
    const text = [
      img.alt,
      img.title,
      img.getAttribute("aria-label"),
      img.closest('[role="progressbar"]')?.getAttribute("aria-label"),
      img.closest('[aria-busy="true"]')?.getAttribute("aria-label")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (
      text.includes("loading") ||
      text.includes("progress") ||
      text.includes("please wait")
    ) {
      return true;
    }

    if (
      img.closest(
        '[role="progressbar"], [aria-busy="true"]'
      )
    ) {
      return true;
    }

    const src = String(
      img.currentSrc ||
      img.src ||
      ""
    ).toLowerCase();

    return (
      src.includes("spinner") ||
      src.includes("loading") ||
      src.includes("progress") ||
      src.includes("placeholder") ||
      src.includes("shimmer")
    );
  }

  /*
    Check whether Facebook currently has a visible loader in the
    Marketplace media area.
  */
  function visibleMarketplaceLoaderExists() {
    const loaders = Array.from(
      document.querySelectorAll(
        [
          '[role="progressbar"]',
          '[aria-busy="true"]',
          '[aria-label*="Loading" i]'
        ].join(", ")
      )
    );

    return loaders.some(loader => {
      const rect =
        loader.getBoundingClientRect();

      const style =
        window.getComputedStyle(loader);

      return (
        rect.width > 20 &&
        rect.height > 20 &&
        rect.bottom > 80 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth * 0.75 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0
      );
    });
  }

  /*
    Do not scrape immediately after opening a listing or clicking the
    next-photo button. Wait until:

    1. No visible loader remains.
    2. The visible image candidates remain unchanged for several checks.
  */
  async function waitForMarketplacePhotoToSettle(
    timeoutMs = 4500
  ) {
    const startedAt = Date.now();

    let stableChecks = 0;
    let previousSignature = "";

    while (
      Date.now() - startedAt <
      timeoutMs
    ) {
      const candidates = Array.from(
        document.querySelectorAll("img")
      )
        .filter(
          img =>
            !elementLooksLikeLoader(img)
        )
        .map(img => {
          const rect =
            img.getBoundingClientRect();

          return {
            src:
              img.currentSrc ||
              img.src ||
              "",

            width: rect.width,
            height: rect.height,

            top:
              Math.round(rect.top),

            left:
              Math.round(rect.left)
          };
        })
        .filter(
          img =>
            img.src.includes("fbcdn.net")
        )
        .filter(
          img =>
            img.width >= 220 &&
            img.height >= 180
        )
        .filter(
          img =>
            img.top > -250
        )
        .filter(
          img =>
            img.top <
            window.innerHeight + 250
        )
        .filter(
          img =>
            img.left <
            window.innerWidth * 0.72
        )
        .sort(
          (a, b) =>
            b.width * b.height -
            a.width * a.height
        )
        .slice(0, 3);

      const signature =
        JSON.stringify(candidates);

      const loaderVisible =
        visibleMarketplaceLoaderExists();

      if (
        !loaderVisible &&
        signature &&
        signature === previousSignature
      ) {
        stableChecks += 1;
      } else {
        stableChecks = 0;
      }

      if (stableChecks >= 2) {
        return;
      }

      previousSignature = signature;

      await sleep(300);
    }
  }

  function collectVisibleListingImages() {
    const allImages = Array.from(
      document.querySelectorAll("img")
    );

    let listingImages = allImages
      .map(img => {
        const rect =
          img.getBoundingClientRect();

        return {
          el: img,

          src:
            img.currentSrc ||
            img.src ||
            "",

          naturalWidth:
            img.naturalWidth || 0,

          naturalHeight:
            img.naturalHeight || 0,

          rect,

          renderedArea:
            Math.max(0, rect.width) *
            Math.max(0, rect.height)
        };
      })

      .filter(img => img.src)
      .filter(
        img =>
          img.src.startsWith("http")
      )
      .filter(
        img =>
          img.src.includes("fbcdn.net")
      )

      // Reject Facebook loaders and placeholders.
      .filter(
        img =>
          !elementLooksLikeLoader(img.el)
      )

      .filter(
        img =>
          !img.src.includes("emoji")
      )
      .filter(
        img =>
          !img.src.includes("profile")
      )
      .filter(
        img =>
          !img.src.includes("static")
      )

      /*
        Use the actual on-screen dimensions.

        The old version relied heavily on naturalWidth/naturalHeight,
        which can allow hidden or unrelated large Facebook assets.
      */
      .filter(
        img =>
          img.rect.width >= 220
      )
      .filter(
        img =>
          img.rect.height >= 180
      )
      .filter(
        img =>
          img.renderedArea >= 50000
      )

      /*
        Limit candidates to the visible Marketplace media column.
      */
      .filter(
        img =>
          img.rect.top > -250
      )
      .filter(
        img =>
          img.rect.top <
          window.innerHeight + 250
      )
      .filter(
        img =>
          img.rect.left > -50
      )
      .filter(
        img =>
          img.rect.left <
          window.innerWidth * 0.72
      )
      .filter(
        img =>
          img.rect.right > 80
      );

    /*
      Determine the dominant visible image, then reject images that
      are much smaller.

      This helps remove thumbnails, avatars, recommendation cards,
      and interface graphics.
    */
    const largestRenderedArea = Math.max(
      0,
      ...listingImages.map(
        img => img.renderedArea
      )
    );

    if (largestRenderedArea > 0) {
      listingImages =
        listingImages.filter(
          img =>
            img.renderedArea >=
            largestRenderedArea * 0.55
        );
    }

    listingImages.sort((a, b) => {
      if (
        Math.abs(
          b.renderedArea -
          a.renderedArea
        ) > 5000
      ) {
        return (
          b.renderedArea -
          a.renderedArea
        );
      }

      return (
        a.rect.left -
        b.rect.left
      );
    });

    for (const img of listingImages) {
      seen.add(img.src);
    }

    console.log(
      "Visible listing image candidates after loader filtering:",
      listingImages.map(
        ({ el, ...candidate }) =>
          candidate
      )
    );
  }

  function findNextPhotoButton() {
    const buttons = Array.from(
      document.querySelectorAll(
        '[role="button"], button'
      )
    );

    return buttons.find(button => {
      const rect =
        button.getBoundingClientRect();

      const label = [
        button.getAttribute("aria-label"),
        button.innerText,
        button.title
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const isRightSide =
        rect.left >
          window.innerWidth * 0.5 &&
        rect.top > 100 &&
        rect.top <
          window.innerHeight - 60;

      const buttonText =
        String(
          button.innerText || ""
        ).trim();

      const looksLikeNext =
        label.includes("next") ||
        label.includes("see next") ||
        label.includes("next photo") ||
        buttonText === "›" ||
        buttonText === ">";

      return (
        isRightSide &&
        looksLikeNext
      );
    });
  }

  /*
    Wait for Facebook to replace the purple loading graphic with the
    actual listing photo before collecting anything.
  */
  await waitForMarketplacePhotoToSettle();

  collectVisibleListingImages();

  for (let i = 0; i < 8; i++) {
    const beforeCount = seen.size;

    const nextButton =
      findNextPhotoButton();

    if (!nextButton) {
      console.log(
        "No next photo button found."
      );

      break;
    }

    nextButton.click();

    /*
      Replace the old fixed sleep(700) with an actual wait for the
      next image and loader state to stabilize.
    */
    await waitForMarketplacePhotoToSettle();

    collectVisibleListingImages();

    if (seen.size === beforeCount) {
      console.log(
        "No new image found after clicking next."
      );

      break;
    }

    if (seen.size >= 8) {
      break;
    }
  }

  const uniqueUrls = [...seen];

  const carouselCount =
    getMarketplaceCarouselThumbnailCount();

  /*
    Preserve your existing rule:

    - Detected carousel: return up to its thumbnail count.
    - No carousel: return only one image.
  */
  const finalLimit =
    Number.isInteger(carouselCount) &&
    carouselCount > 0
      ? Math.min(carouselCount, 8)
      : 1;

  const finalUrls =
    uniqueUrls.slice(0, finalLimit);

  console.log(
    "Detected carousel image count:",
    carouselCount
  );

  console.log(
    "Final listing image URLs after loader filtering and carousel trim:",
    finalUrls
  );

  return finalUrls;
}

function normalizeConditionForEbay(condition) {
  const c = String(condition || "").toLowerCase();

  if (c.includes("open box")) return "1500";
  if (c.includes("new")) return "1000";
  if (c.includes("parts") || c.includes("repair")) return "7000";
  if (c.includes("used")) return "3000";

  return "3000";
}

function normalizeNegativeSearchTerms(terms) {
  if (!Array.isArray(terms)) return [];

  const blocked = new Set([
    "",
    "used",
    "new",
    "open box",
    "broken",
    "tested",
    "working",
    "bundle",
    "lot",
    "parts",
    "repair",
    "camera",
    "lens",
    "body",
    "charger",
    "case",
    "strap",
    "battery",
    "manual",
    "box"
  ]);

  const seen = new Set();

  return terms
    .map(term => String(term || "").trim())
    .filter(Boolean)
    .filter(term => term.length <= 40)
    .filter(term => !blocked.has(term.toLowerCase()))
    .filter(term => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

function formatEbayNegativeTerm(term) {
  const clean = String(term || "").trim();

  if (!clean) return "";

  if (/\s/.test(clean)) {
    return `-"${clean.replaceAll('"', "")}"`;
  }

  return `-${clean}`;
}

function buildEbayQueryWithNegativeTerms(query, negativeSearchTerms) {
  const cleanQuery = String(query || "").trim();

  const negatives = normalizeNegativeSearchTerms(negativeSearchTerms)
    .map(formatEbayNegativeTerm)
    .filter(Boolean);

  return [cleanQuery, ...negatives].filter(Boolean).join(" ");
}

function buildEbaySoldSearchUrl(query, condition, negativeSearchTerms = []) {
  const finalQuery = buildEbayQueryWithNegativeTerms(query, negativeSearchTerms);
  const encodedQuery = encodeURIComponent(finalQuery);
  const conditionCode = normalizeConditionForEbay(condition);

  return (
    `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}` +
    `&LH_Sold=1&LH_Complete=1` +
    `&LH_ItemCondition=${conditionCode}` +
    `&_sop=13`
  );
}

function openEbaySoldSearch(query, condition, negativeSearchTerms = []) {
  const cleanQuery = String(query || "").trim();

  if (!cleanQuery) {
    console.warn(
      "Blocked blank eBay search query. Skipping search without popup.",
      {
        query,
        condition
      }
    );

    return false;
  }

  const finalQuery = buildEbayQueryWithNegativeTerms(
    cleanQuery,
    negativeSearchTerms
  );

  const url = buildEbaySoldSearchUrl(
    cleanQuery,
    condition,
    negativeSearchTerms
  );

  console.log("Opening eBay URL:", url);
  console.log("Opening eBay query with negative terms:", {
    baseQuery: cleanQuery,
    negativeSearchTerms:
      normalizeNegativeSearchTerms(negativeSearchTerms),
    finalQuery
  });

  window.open(url, "_blank");

  return true;
}

function getCurrentFacebookListingUrl() {
  return window.location.href;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showDebugPreview({
  title,
  description,
  imageUrls,
  screenshotDataUrl = null,
  referenceCollageDataUrl = null,
  galleries = [],
  aiResult = null
}) {
  const existing = document.getElementById("ebay-ai-debug-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "ebay-ai-debug-panel";

  const imageHtml = imageUrls.length
    ? imageUrls
        .map(
          src => `
            <div style="margin-bottom:8px;">
              <img src="${escapeHtml(src)}" style="width:100%; max-height:140px; object-fit:cover; border-radius:8px; border:1px solid #ddd;" />
              <div style="font-size:10px; color:#666; word-break:break-all; margin-top:3px;">${escapeHtml(src)}</div>
            </div>
          `
        )
        .join("")
    : `<div style="color:#999;">No images detected.</div>`;

const screenshotHtml = screenshotDataUrl
  ? `
    <hr style="margin:12px 0;" />
    <div style="font-weight:700; margin-bottom:6px;">Page screenshot sent to AI</div>
    <img src="${screenshotDataUrl}" style="width:100%; max-height:360px; object-fit:contain; border-radius:8px; border:1px solid #ddd; background:#fff;" />
  `
  : "";

const listingImagesSentHtml = aiResult?.listingImagesSent != null
  ? `
    <hr style="margin:12px 0;" />
    <div style="font-weight:700; margin-bottom:6px;">Listing images sent to AI</div>
    <div style="font-size:12px;">${escapeHtml(aiResult.listingImagesSent)} separate listing image(s) sent.</div>
  `
  : "";

  const referenceHtml = referenceCollageDataUrl
  ? `
    <hr style="margin:12px 0;" />
    <div style="font-weight:700; margin-bottom:6px;">Reference images checked by AI</div>
    <img src="${referenceCollageDataUrl}" style="width:100%; max-height:360px; object-fit:contain; border-radius:8px; border:1px solid #ddd; background:#fff;" />
  `
  : "";

const galleriesHtml =
  Array.isArray(galleries) &&
  galleries.length
    ? `
      <hr style="margin:12px 0;" />

      <div style="
        font-weight:700;
        margin-bottom:8px;
      ">
        Step 2 Gallery Collages
      </div>

      ${galleries
        .map(
          gallery => `
            <div style="
              margin-bottom:16px;
            ">
              <div style="
                font-size:12px;
                font-weight:700;
                margin-bottom:5px;
              ">
                Gallery ${gallery.galleryIndex}
                — Images ${gallery.startingImageIndex}
                through ${gallery.endingImageIndex}
              </div>

              ${
                gallery.debugCollageDataUrl
                  ? `
                    <img
                      src="${gallery.debugCollageDataUrl}"
                      style="
                        width:100%;
                        max-height:500px;
                        object-fit:contain;
                        border-radius:8px;
                        border:1px solid #ddd;
                        background:#fff;
                      "
                    />
                  `
                  : `
                    <div style="
                      font-size:11px;
                      color:#999;
                    ">
                      No collage image available.
                    </div>
                  `
              }

              <pre style="
                white-space:pre-wrap;
                background:#f5f5f5;
                padding:8px;
                border-radius:6px;
                font-size:10px;
                max-height:220px;
                overflow:auto;
                margin-top:6px;
              ">${escapeHtml(
                JSON.stringify(
                  gallery.galleryAnalysis,
                  null,
                  2
                )
              )}</pre>
            </div>
          `
        )
        .join("")}
    `
    : "";

  const aiHtml = aiResult
    ? `
      <hr style="margin:12px 0;" />
      <div style="font-weight:700; margin-bottom:6px;">AI Result</div>
      <pre style="white-space:pre-wrap; background:#f5f5f5; padding:8px; border-radius:6px; font-size:11px;">${escapeHtml(JSON.stringify(aiResult, null, 2))}</pre>
    `
    : "";

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div style="font-weight:700; font-size:14px;">Data sent to AI</div>
      <button id="ebay-ai-debug-close" style="border:none; background:#eee; padding:4px 8px; border-radius:6px; cursor:pointer;">Close</button>
    </div>

    <hr style="margin:10px 0;" />

    <div style="font-size:12px; font-weight:700;">Title</div>
    <div style="font-size:12px; margin-bottom:10px;">${escapeHtml(title || "No title detected")}</div>

    <div style="font-size:12px; font-weight:700;">Description / Text</div>
    <pre style="white-space:pre-wrap; background:#f5f5f5; padding:8px; border-radius:6px; font-size:11px; max-height:140px; overflow:auto;">${escapeHtml(description || "No description detected")}</pre>

    <div style="font-size:12px; font-weight:700; margin-top:10px;">Images detected: ${imageUrls.length}</div>
    <div style="max-height:360px; overflow:auto; margin-top:6px;">
      ${imageHtml}
    </div>

${screenshotHtml}
${listingImagesSentHtml}
${referenceHtml}
${galleriesHtml}
${aiHtml}
  `;

  document.body.appendChild(panel);

  document.getElementById("ebay-ai-debug-close").onclick = () => {
    panel.remove();
  };
}

async function skipAutoListingBecauseOverPriceLimit(price) {
  const stored = await chrome.storage.local.get(MARKETPLACE_AUTO_STATE_KEY);
  const state = stored[MARKETPLACE_AUTO_STATE_KEY];

  if (!state?.running) {
    return false;
  }

  const currentUrl = window.location.href.split("?")[0];

  const currentListingId = getFacebookMarketplaceItemId(currentUrl);

  const processedListingUrls = [
    ...(state.processedListingUrls || []),
    state.currentListingUrl || currentUrl
  ];

  await chrome.storage.local.set({
    [MARKETPLACE_AUTO_STATE_KEY]: {
      ...state,
      processedListingUrls: [...new Set(processedListingUrls)],
      currentListingUrl: "",
      waitingForAnalysis: false,
      analysisDone: false,
      lastResult: {
        recommendation: "Skipped",
        reason: `Skipped because Facebook asking price was $${price}, above the $${MAX_FACEBOOK_ASK_PRICE} limit.`
      },
      lastResultAt: Date.now()
    }
  });

console.log(
  `Skipping listing because Facebook asking price $${price} is above $${MAX_FACEBOOK_ASK_PRICE}. Closing listing tab.`
);

await sleep(
  500
);

await closeCurrentMarketplaceListingTab();

return true;
}

function getFacebookAskingPrice() {
  function parsePrice(text) {
    const clean =
      String(text || "").trim();

    if (
      !/^\$[\d,]+(?:\.\d{2})?$/.test(clean)
    ) {
      return null;
    }

    const value =
      Number(
        clean
          .replace("$", "")
          .replace(/,/g, "")
      );

    return (
      Number.isFinite(value) &&
      value > 0 &&
      value < 100000
    )
      ? value
      : null;
  }


  const elements =
    Array.from(
      document.querySelectorAll(
        "span, div"
      )
    );


  for (const element of elements) {
    const price =
      parsePrice(
        element.innerText ||
        element.textContent
      );

    if (price == null) {
      continue;
    }


    /*
      Facebook discounted listings can show:

        $350   $450

      where $450 is the old crossed-out price.

      Never use a struck-through price as the
      current Marketplace asking price.
    */
    const style =
      window.getComputedStyle(
        element
      );

    const textDecoration =
      String(
        style.textDecoration ||
        style.textDecorationLine ||
        ""
      ).toLowerCase();


    if (
      textDecoration.includes(
        "line-through"
      )
    ) {
      continue;
    }


    /*
      Also check parent styling because Facebook
      may apply the line-through to a wrapper
      instead of the text element itself.
    */
    const parent =
      element.parentElement;

    if (parent) {
      const parentStyle =
        window.getComputedStyle(
          parent
        );

      const parentDecoration =
        String(
          parentStyle.textDecoration ||
          parentStyle.textDecorationLine ||
          ""
        ).toLowerCase();

      if (
        parentDecoration.includes(
          "line-through"
        )
      ) {
        continue;
      }
    }


    return price;
  }


  return null;
}

function captureVisibleTabScreenshot() {
  return new Promise(resolve => {
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.sendMessage
    ) {
      console.warn("chrome.runtime.sendMessage is unavailable. Continuing without screenshot.");
      resolve(null);
      return;
    }

    try {
      chrome.runtime.sendMessage(
        {
          type: "CAPTURE_VISIBLE_TAB"
        },
        response => {
          if (chrome.runtime.lastError) {
            console.warn("Screenshot capture failed:", chrome.runtime.lastError.message);
            resolve(null);
            return;
          }

          if (!response || !response.ok) {
            console.warn("Screenshot capture failed:", response?.error);
            resolve(null);
            return;
          }

          resolve(response.screenshotDataUrl);
        }
      );
    } catch (error) {
      console.warn("Screenshot capture threw error:", error.message);
      resolve(null);
    }
  });
}

function itemLooksLikeCameraOrLens(item) {
  const text = [
    item?.brand,
    item?.model,
    item?.productType,
    item?.ebaySearchQuery,
    item?.reason
  ]
    .join(" ")
    .toLowerCase();

  const cameraLensTerms = [
    "camera",
    "camera body",
    "film camera",
    "digital camera",
    "dslr",
    "mirrorless",
    "point and shoot",
    "point-and-shoot",
    "bridge camera",
    "lens",
    "camera lens",
    "zoom lens",
    "prime lens"
  ];

  return cameraLensTerms.some(term => text.includes(term));
}

function listingLooksLikeCameraOrLens(data, primaryItems) {
  const cameraAnalysis = data?.cameraAnalysis || {};

  if (cameraAnalysis.isCameraListing === true) return true;
  if (cameraAnalysis.cameraBodyVisible === true) return true;
  if (cameraAnalysis.lensVisible === true) return true;

  return primaryItems.some(itemLooksLikeCameraOrLens);
}

function parsePriceValue(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return value > 0 && value < 100000 ? value : null;
  }

  const text = String(value).replace(/,/g, "");
  const match = text.match(/\$?\s*(\d+(\.\d{1,2})?)/);

  if (!match) return null;

  const price = Number(match[1]);

  if (!price || Number.isNaN(price)) return null;
  if (price <= 0 || price >= 100000) return null;

  return price;
}

async function showSessionListingsLibrary() {
  const stored = await chrome.storage.local.get(SESSION_LISTINGS_KEY);

  const library = Array.isArray(stored[SESSION_LISTINGS_KEY])
    ? stored[SESSION_LISTINGS_KEY]
    : [];

  const existing = document.getElementById("session-listings-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "session-listings-panel";

  function money(value) {
    if (value === null || value === undefined) return "N/A";
    const num = Number(value);
    if (Number.isNaN(num)) return "N/A";
    return "$" + num.toFixed(2).replace(/\.00$/, "");
  }

  const rows = library.map(entry => {
    const recommendation = entry.recommendation || "Not analyzed yet";

    return `
      <div style="border:1px solid #ddd; border-radius:8px; padding:10px; margin-bottom:10px; background:#fafafa;">
        <div style="font-weight:800; font-size:13px;">
          ${escapeHtml(entry.title || entry.sourceText || "Untitled Marketplace listing")}
        </div>

        <div style="font-size:11px; color:#555; margin-top:4px;">
          <b>Recommendation:</b> ${escapeHtml(recommendation)}
          &nbsp; <b>Ask:</b> ${money(entry.facebookPrice)}
        </div>

        <div style="font-size:11px; color:#555; margin-top:4px;">
          <b>Estimated resale:</b> ${money(entry.estimatedResaleValue)}
          &nbsp; <b>Profit at ask:</b> ${money(entry.profitAtAsk)}
          &nbsp; <b>Profit at 35%:</b> ${money(entry.profitAt35)}
        </div>

        ${
          entry.reason
            ? `<div style="font-size:11px; color:#555; margin-top:4px;"><b>Reason:</b> ${escapeHtml(entry.reason)}</div>`
            : ""
        }

        <div style="font-size:11px; color:#777; margin-top:4px;">
          Clicked: ${escapeHtml(new Date(entry.clickedAt).toLocaleString())}
          ${
            entry.analyzedAt
              ? ` · Analyzed: ${escapeHtml(new Date(entry.analyzedAt).toLocaleString())}`
              : ""
          }
        </div>

        ${
          entry.facebookUrl
            ? `<div style="margin-top:6px;"><a href="${escapeHtml(entry.facebookUrl)}" target="_blank" rel="noopener noreferrer">Open Facebook listing</a></div>`
            : ""
        }
      </div>
    `;
  }).join("");

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div style="font-weight:800; font-size:14px;">Session Listings</div>

      <div style="display:flex; gap:6px;">
        <button id="session-listings-clear" style="border:none; background:#ffe5e5; color:#900; padding:4px 8px; border-radius:6px; cursor:pointer;">Clear</button>
        <button id="session-listings-close" style="border:none; background:#eee; padding:4px 8px; border-radius:6px; cursor:pointer;">Close</button>
      </div>
    </div>

    <hr style="margin:10px 0;" />

    <div style="font-size:12px; margin-bottom:8px;">
      Session listings clicked: ${library.length}
    </div>

    <div style="max-height:520px; overflow:auto;">
      ${rows || `<div style="color:#777;">No session listings saved yet.</div>`}
    </div>
  `;

  Object.assign(panel.style, {
    position: "fixed",
    top: "80px",
    right: "20px",
    width: "460px",
    maxHeight: "700px",
    overflow: "auto",
    background: "#fff",
    color: "#111",
    zIndex: "999999",
    padding: "14px",
    borderRadius: "10px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.25)",
    fontFamily: "Arial, sans-serif"
  });

  document.body.appendChild(panel);

  document.getElementById("session-listings-clear").onclick = async () => {
    await clearSessionListingsLibrary();
  };

  document.getElementById("session-listings-close").onclick = () => {
    panel.remove();
  };
}

async function showSavedDealLibrary() {
  const stored = await chrome.storage.local.get("savedDealLibrary");
  const library = Array.isArray(stored.savedDealLibrary)
    ? stored.savedDealLibrary
    : [];

  const existing = document.getElementById("saved-deal-library-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "saved-deal-library-panel";

  function money(value) {
    if (value === null || value === undefined) return "N/A";
    const num = Number(value);
    if (Number.isNaN(num)) return "N/A";
    return "$" + num.toFixed(2).replace(/\.00$/, "");
  }

  const rows = library.map(entry => `
    <div style="border-bottom:1px solid #eee; padding:10px 0;">
      <div style="font-weight:800; font-size:13px;">
        ${escapeHtml(entry.recommendation || "")}: ${escapeHtml(entry.title || "")}
      </div>

      <div style="font-size:12px; margin-top:4px;">
        <b>Ask:</b> ${money(entry.facebookPrice)}
        &nbsp; <b>Resale:</b> ${money(entry.estimatedResaleValue)}
        &nbsp; <b>Profit ask:</b> ${money(entry.profitAtAsk)}
        &nbsp; <b>Profit 35%:</b> ${money(entry.profitAt35)}
        &nbsp; <b>Max buy:</b> ${money(entry.maxBuyPrice)}
      </div>

      <div style="font-size:11px; color:#555; margin-top:4px;">
        ${escapeHtml(entry.reason || "")}
      </div>

      <div style="font-size:11px; color:#777; margin-top:4px;">
        Saved: ${escapeHtml(new Date(entry.savedAt).toLocaleString())}
      </div>

      ${
        entry.facebookUrl
          ? `<div style="margin-top:6px;"><a href="${escapeHtml(entry.facebookUrl)}" target="_blank" rel="noopener noreferrer">Open Facebook listing</a></div>`
          : ""
      }
    </div>
  `).join("");

panel.innerHTML = `
  <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
    <div style="font-weight:800; font-size:14px;">Saved Deal Library</div>

    <div style="display:flex; gap:6px;">
      <button id="saved-deal-library-clear" style="border:none; background:#ffe5e5; color:#900; padding:4px 8px; border-radius:6px; cursor:pointer;">Clear</button>
      <button id="saved-deal-library-close" style="border:none; background:#eee; padding:4px 8px; border-radius:6px; cursor:pointer;">Close</button>
    </div>
  </div>

    <hr style="margin:10px 0;" />

    <div style="font-size:12px; margin-bottom:8px;">
      Saved listings: ${library.length}
    </div>

    <div style="max-height:520px; overflow:auto;">
      ${rows || `<div style="color:#777;">No saved Buy Now or Negotiate listings yet.</div>`}
    </div>
  `;

  document.body.appendChild(panel);

  document.getElementById("saved-deal-library-close").onclick = () => {
    panel.remove();
  };

  document.getElementById("saved-deal-library-clear").onclick = async () => {
    await clearSavedDealLibrary();
  };
}

async function showScamListingsLibrary() {
  const stored = await chrome.storage.local.get(
    SCAM_LISTINGS_KEY
  );

  const library = Array.isArray(
    stored[SCAM_LISTINGS_KEY]
  )
    ? stored[SCAM_LISTINGS_KEY]
    : [];

  const existing =
    document.getElementById(
      "scam-listings-panel"
    );

  if (existing) {
    existing.remove();
  }

  const panel =
    document.createElement("div");

  panel.id = "scam-listings-panel";

  function money(value) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      return "N/A";
    }

    const num = Number(value);

    if (!Number.isFinite(num)) {
      return "N/A";
    }

    return (
      "$" +
      num
        .toFixed(2)
        .replace(/\.00$/, "")
    );
  }

  const rows = library
    .map(entry => {
      const ratio =
        Number.isFinite(
          Number(entry.resaleToAskRatio)
        )
          ? `${Number(
              entry.resaleToAskRatio
            ).toFixed(2)}x`
          : "N/A";

      const threshold =
        Number.isFinite(
          Number(entry.maxResaleToAskRatio)
        )
          ? `${Number(
              entry.maxResaleToAskRatio
            )}x`
          : "2.5x";

      const itemNames =
        Array.isArray(entry.items)
          ? entry.items
              .filter(
                item =>
                  item?.isPrimarySellableItem !==
                  false
              )
              .map(item => {
                return (
                  item.ebaySearchQuery ||
                  `${item.brand || ""} ${
                    item.model || ""
                  } ${
                    item.productType || ""
                  }`
                    .replace(/\s+/g, " ")
                    .trim()
                );
              })
              .filter(Boolean)
          : [];

      return `
        <div style="
          border-bottom:1px solid #ddd;
          padding:12px 0;
        ">
          <div style="
            font-weight:800;
            font-size:13px;
          ">
            ${escapeHtml(
              entry.title ||
              "Untitled listing"
            )}
          </div>

          <div style="
            font-size:12px;
            margin-top:5px;
          ">
            <b>Ask:</b>
            ${money(entry.facebookPrice)}

            &nbsp;

            <b>Estimated resale:</b>
            ${money(
              entry.estimatedResaleValue
            )}
          </div>

          <div style="
            font-size:12px;
            margin-top:4px;
            color:#a00000;
          ">
            <b>Resale-to-ask ratio:</b>
            ${escapeHtml(ratio)}

            &nbsp;

            <b>Threshold:</b>
            ${escapeHtml(threshold)}
          </div>

          ${
            itemNames.length
              ? `
                <div style="
                  font-size:11px;
                  color:#444;
                  margin-top:5px;
                ">
                  <b>Products:</b>
                  ${escapeHtml(
                    itemNames.join(", ")
                  )}
                </div>
              `
              : ""
          }

          <div style="
            font-size:11px;
            color:#555;
            margin-top:5px;
          ">
            <b>Reason:</b>
            ${escapeHtml(
              entry.reason || ""
            )}
          </div>

          <div style="
            font-size:11px;
            color:#777;
            margin-top:5px;
          ">
            Saved:
            ${escapeHtml(
              new Date(
                entry.savedAt
              ).toLocaleString()
            )}
          </div>

          ${
            entry.facebookUrl
              ? `
                <div style="margin-top:7px;">
                  <a
                    href="${escapeHtml(
                      entry.facebookUrl
                    )}"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Facebook listing
                  </a>
                </div>
              `
              : ""
          }
        </div>
      `;
    })
    .join("");

  panel.innerHTML = `
    <div style="
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:8px;
    ">
      <div style="
        font-weight:800;
        font-size:14px;
      ">
        Scam Listings
      </div>

      <div style="
        display:flex;
        gap:6px;
      ">
        <button
          id="scam-listings-clear"
          style="
            border:none;
            background:#ffe5e5;
            color:#900;
            padding:4px 8px;
            border-radius:6px;
            cursor:pointer;
          "
        >
          Clear
        </button>

        <button
          id="scam-listings-close"
          style="
            border:none;
            background:#eee;
            padding:4px 8px;
            border-radius:6px;
            cursor:pointer;
          "
        >
          Close
        </button>
      </div>
    </div>

    <hr style="margin:10px 0;" />

    <div style="
      font-size:12px;
      margin-bottom:8px;
    ">
      Scam listings: ${library.length}
    </div>

    <div style="
      max-height:520px;
      overflow:auto;
    ">
      ${
        rows ||
        `
          <div style="color:#777;">
            No scam listings yet.
          </div>
        `
      }
    </div>
  `;

  Object.assign(panel.style, {
    position: "fixed",
    top: "80px",
    right: "20px",
    width: "440px",
    maxHeight: "700px",
    overflow: "auto",
    background: "#fff",
    color: "#111",
    zIndex: "999999",
    padding: "14px",
    borderRadius: "10px",
    boxShadow:
      "0 4px 24px rgba(0,0,0,0.25)",
    fontFamily: "Arial, sans-serif"
  });

  document.body.appendChild(panel);

  document.getElementById(
    "scam-listings-clear"
  ).onclick = async () => {
    await clearScamListingsLibrary();
  };

  document.getElementById(
    "scam-listings-close"
  ).onclick = () => {
    panel.remove();
  };
}

async function clearScamListingsLibrary() {
  const confirmed = confirm(
    "Clear all scam listings?\n\n" +
    "This cannot be undone."
  );

  if (!confirmed) {
    return;
  }

  await chrome.storage.local.set({
    [SCAM_LISTINGS_KEY]: []
  });

  console.log(
    "Scam listings cleared."
  );

  await showScamListingsLibrary();
}

async function clearSavedDealLibrary() {
  const confirmed = confirm(
    "Clear all saved Buy Now / Negotiate listings?\n\nThis cannot be undone."
  );

  if (!confirmed) return;

  await chrome.storage.local.set({
    savedDealLibrary: []
  });

  console.log("Saved deal library cleared.");

  alert("Saved Buy Now / Negotiate listings cleared.");

  await showSavedDealLibrary();
}

const LOCAL_SERVER_BASE_URL = "http://127.0.0.1:3000";

async function isLocalServerRunning() {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 2500);

  try {
    const response = await fetch(
      `${LOCAL_SERVER_BASE_URL}/health`,
      {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      }
    );

    if (!response.ok) {
      return false;
    }

    const data = await response.json();

    return data?.ok === true;
  } catch (error) {
    console.warn(
      "Local analysis server health check failed:",
      error?.message || error
    );

    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLocalServer(
  path,
  options = {},
  settings = {}
) {
  const timeoutMs =
    settings.timeoutMs ||
    240000;

  const retries =
    settings.retries ?? 1;

  let lastError = null;

  /*
    Preserve the existing per-listing
    analysis log association.
  */
  const storedRun =
    await chrome.storage.local.get(
      MARKETPLACE_ANALYSIS_RUN_KEY
    );

  const analysisRunId =
    storedRun[
      MARKETPLACE_ANALYSIS_RUN_KEY
    ]?.id || "";

  const requestHeaders = {
    ...(options.headers || {})
  };

  if (analysisRunId) {
    requestHeaders[
      "X-Analysis-Run-Id"
    ] =
      analysisRunId;
  }

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    try {
      /*
        IMPORTANT:

        Do not fetch localhost directly from
        the Facebook/eBay content script.

        Ask the extension service worker to
        perform the request instead.
      */
      const proxyResult =
        await new Promise(
          (
            resolve,
            reject
          ) => {
            chrome.runtime.sendMessage(
              {
                type:
                  "FETCH_LOCAL_SERVER",

                url:
                  `${LOCAL_SERVER_BASE_URL}${path}`,

                timeoutMs,

                options: {
                  method:
                    options.method ||
                    "GET",

                  headers:
                    requestHeaders,

                  body:
                    options.body ??
                    null
                }
              },

              response => {
                const runtimeError =
                  chrome.runtime
                    .lastError;

                if (runtimeError) {
                  reject(
                    new Error(
                      runtimeError.message
                    )
                  );

                  return;
                }

                if (
                  !response ||
                  response.ok !== true
                ) {
                  reject(
                    new Error(
                      response?.error ||
                      "Background local-server proxy failed."
                    )
                  );

                  return;
                }

                resolve(
                  response.response
                );
              }
            );
          }
        );

      /*
        Recreate a normal Response object.

        This means ALL of your existing code
        can continue using:

          response.ok
          response.status
          response.text()

        without changing every endpoint call.
      */
      const response =
        new Response(
          proxyResult.body,
          {
            status:
              proxyResult.status,

            statusText:
              proxyResult.statusText ||
              "",

            headers:
              Array.isArray(
                proxyResult.headers
              )
                ? proxyResult.headers
                : []
          }
        );

      return response;

} catch (error) {
  lastError =
    error;

  const errorMessage =
    String(
      error?.message ||
      error ||
      ""
    );

  /*
    Reloading an extension invalidates all content
    scripts already injected into open tabs.

    Retrying cannot repair this. The page itself
    must be refreshed.
  */
  if (
    isExtensionContextInvalidated(
      error
    )
  ) {
    throw new Error(
      "Extension context was invalidated. " +
      "Refresh this Facebook/eBay tab after reloading the extension."
    );
  }

  /*
    This means the background service worker did
    not keep/respond to the runtime message.

    Retrying the Node server request is pointless
    until the background messaging problem is fixed.
  */
  if (
    /message port closed|receiving end does not exist/i.test(
      errorMessage
    )
  ) {
    throw new Error(
      "Background service worker did not respond to FETCH_LOCAL_SERVER. " +
      "Check that the FETCH_LOCAL_SERVER handler is in background.js " +
      "and then reload the extension."
    );
  }

  console.warn(
    `Local server fetch failed on attempt ` +
    `${attempt + 1}/${retries + 1}:`,
    errorMessage
  );

  if (
    attempt <
    retries
  ) {
    await sleep(
      1500 *
      (attempt + 1)
    );
  }
}
  }

  throw new Error(
    `Local server fetch failed after ` +
    `${retries + 1} attempt(s): ` +
    `${lastError?.message || "unknown error"}. ` +
    `Check that the server is running at ` +
    `${LOCAL_SERVER_BASE_URL}.`
  );
}

class LocalServerError extends Error {
  constructor(data, fallbackMessage) {
    super(
      data?.error ||
      data?.reason ||
      fallbackMessage ||
      "Local server request failed."
    );

    this.name = "LocalServerError";
    this.code = data?.code || "SERVER_ERROR";
    this.step = data?.step || "";
    this.retryEntireListing =
      data?.retryEntireListing === true;
  }
}

async function readJsonSafely(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Server returned non-JSON or malformed JSON:", {
      status: response.status,
      statusText: response.statusText,
      text: text.slice(0, 2000)
    });

   return {
  error: "Server returned malformed JSON.",
  code: "MALFORMED_SERVER_JSON",
  retryEntireListing: true,
  step: "Reading local server response",
  rawResponse: text.slice(0, 2000)
};
  }
}

function pickBestGoogleTargets(
  galleries,
  imageUrls
) {
  /*
    productId is GLOBAL across galleries.

    camera_1 in Gallery 1 and camera_1 in Gallery 2
    represent the same physical product.

    Keep exactly ONE best OCR / image-search target
    for each global productId.
  */
  const bestByProductId =
    new Map();


  for (
    const gallery of galleries || []
  ) {
    const analysis =
      gallery?.galleryAnalysis || {};

    const products =
      Array.isArray(
        analysis.products
      )
        ? analysis.products
        : [];

    const images =
      Array.isArray(
        analysis.images
      )
        ? analysis.images
        : [];


    for (
      const product of products
    ) {
      const productId =
        String(
          product?.productId || ""
        ).trim();

      if (!productId) {
        continue;
      }


      for (
        const imageEntry of images
      ) {
        const visibleProducts =
          Array.isArray(
            imageEntry.visibleProducts
          )
            ? imageEntry.visibleProducts
            : [];


        const match =
          visibleProducts.find(
            item =>
              String(
                item?.productId || ""
              ).trim() ===
              productId
          );


        if (!match) {
          continue;
        }


        const imageIndex =
          Number(
            imageEntry.imageIndex
          );

        const score =
          Number(
            match.modelReadabilityScore
          );

        const imageUrl =
          imageUrls[
            imageIndex - 1
          ];


        if (!imageUrl) {
          continue;
        }


        const sameTypeProductIds =
          visibleProducts
            .filter(
              item =>
                String(
                  item?.productType || ""
                )
                  .trim()
                  .toLowerCase() ===
                String(
                  product?.productType || ""
                )
                  .trim()
                  .toLowerCase()
            )
            .map(
              item =>
                String(
                  item?.productId || ""
                ).trim()
            )
            .filter(Boolean);


        const candidate = {
          galleryIndex:
            gallery.galleryIndex,

          productId,

          productType:
            product.productType,

          bestImageIndex:
            imageIndex,

          modelReadabilityScore:
            score,

          imageUrl,

          sameTypeProductIds
        };


        const existing =
          bestByProductId.get(
            productId
          );


        /*
          Pick the highest readability score
          across ALL galleries.

          On a tie, use the earlier Marketplace image.
        */
        if (
          !existing ||
          score >
            existing
              .modelReadabilityScore ||
          (
            score ===
              existing
                .modelReadabilityScore &&
            imageIndex <
              existing
                .bestImageIndex
          )
        ) {
          bestByProductId.set(
            productId,
            candidate
          );
        }
      }
    }
  }


  return Array.from(
    bestByProductId.values()
  );
}

function buildEbaySearchQueryFromPrimaryProduct(
  product
) {
  const brand =
    String(
      product?.brand || ""
    ).trim();

  const model =
    String(
      product?.model || ""
    ).trim();

  const productType =
    String(
      product?.productType || ""
    )
      .trim()
      .toLowerCase();

  /*
    Do not allow generic eBay searches for an
    unresolved model.
  */
  if (!model) {
    return "";
  }

  const identity =
    [brand, model]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  if (!identity) {
    return "";
  }

  if (productType === "camera body") {
    return `${identity} body`;
  }

  if (productType === "camera lens") {
    return `${identity} lens`;
  }

  if (productType === "camera") {
    return `${identity} camera`;
  }

  if (productType === "flash") {
    return `${identity} flash`;
  }

  return identity;
}


function convertReconciledProductToCompItem(
  product,
  index,
  condition = "Used"
) {
  const productId =
    String(
      product?.productId ||
      `product_${index + 1}`
    ).trim();

  return {
    itemId:
      productId,

    productId,

    brand:
      String(
        product?.brand || ""
      ).trim(),

    model:
      String(
        product?.model || ""
      ).trim(),

    productType:
      String(
        product?.productType || ""
      ).trim(),

    condition:
      condition || "Used",

    confidence:
      product?.model
        ? 100
        : 0,

    isPrimarySellableItem:
      true,

    ebaySearchQuery:
      buildEbaySearchQueryFromPrimaryProduct(
        product
      ),

    negativeSearchTerms:
      [],

    reason:
      "Identified by the gallery + Google Lens reconciliation pipeline."
  };
}

async function getOrCreateMarketplaceAnalysisRun() {
  const listingId =
    getFacebookMarketplaceItemId() ||
    "unknown_listing";

  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_ANALYSIS_RUN_KEY
    );

  const existing =
    stored[
      MARKETPLACE_ANALYSIS_RUN_KEY
    ];

  /*
    Reuse the existing run when the SAME listing
    is being restarted/retried.

    This allows malformed-JSON retries and other
    full listing restarts to remain in one log.
  */
  if (
    existing?.id &&
    existing?.listingId === listingId &&
    !existing?.completedAt &&
    Date.now() -
      Number(existing.startedAt || 0) <
      2 * 60 * 60 * 1000
  ) {
    return existing;
  }

  const randomPart =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : (
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2)
        );

  const run = {
    id:
      `${listingId}_${randomPart}`,

    listingId,

    startedAt:
      Date.now(),

    completedAt:
      null
  };

  await chrome.storage.local.set({
    [MARKETPLACE_ANALYSIS_RUN_KEY]:
      run
  });

  return run;
}


async function markMarketplaceAnalysisRunCompleted() {
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_ANALYSIS_RUN_KEY
    );

  const existing =
    stored[
      MARKETPLACE_ANALYSIS_RUN_KEY
    ];

  if (!existing?.id) {
    return;
  }

  await chrome.storage.local.set({
    [MARKETPLACE_ANALYSIS_RUN_KEY]: {
      ...existing,
      completedAt:
        Date.now()
    }
  });
}

async function createRemoteEbayJob({
  ebayUrl,
  context
}) {
  const marketplaceListingId =
    getFacebookMarketplaceItemId(
      context.facebookUrl
    );

  const response =
    await fetchLocalServer(
      "/ebay-worker/jobs",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            ebayUrl,

            marketplaceListingId,

            marketplaceUrl:
              context.facebookUrl
          })
      }
    );

  const data =
    await readJsonSafely(
      response
    );

  if (
    !response.ok ||
    data?.ok !== true ||
    !data?.jobId
  ) {
    throw new Error(
      data?.error ||
      "Could not queue remote eBay search."
    );
  }

  console.log(
    "[REMOTE EBAY] Job queued:",
    {
      jobId:
        data.jobId,
      ebayUrl
    }
  );

  return data;
}

async function waitForRemoteEbayJob(
  jobId
) {
  const startedAt =
    Date.now();

  while (
    Date.now() -
      startedAt <
    REMOTE_EBAY_JOB_TIMEOUT_MS
  ) {
    const response =
      await fetchLocalServer(
        `/ebay-worker/jobs/${encodeURIComponent(
          jobId
        )}`,
        {
          method:
            "GET",

          cache:
            "no-store"
        }
      );

    const data =
      await readJsonSafely(
        response
      );

    if (
      !response.ok ||
      data?.ok !== true
    ) {
      throw new Error(
        data?.error ||
        "Could not read remote eBay job."
      );
    }

    if (
      data.status ===
      "completed"
    ) {
      const listings =
        Array.isArray(
          data.listings
        )
          ? data.listings
          : [];

      console.log(
        "[REMOTE EBAY] Result received:",
        {
          jobId,
          listings:
            listings.length
        }
      );

      return listings;
    }

    if (
      data.status ===
      "failed"
    ) {
      throw new Error(
        data.error ||
        "Remote eBay worker reported failure."
      );
    }

    await sleep(
      REMOTE_EBAY_JOB_POLL_INTERVAL_MS
    );
  }

  throw new Error(
    `Remote eBay worker timed out after ${
      Math.round(
        REMOTE_EBAY_JOB_TIMEOUT_MS /
        60000
      )
    } minutes.`
  );
}

async function runSingleRemoteEbaySearch({
  item,
  negativeSearchTerms,
  context
}) {
  const ebayUrl =
    buildEbaySoldSearchUrl(
      item.ebaySearchQuery,
      item.condition,
      negativeSearchTerms
    );

  console.log(
    "[REMOTE EBAY] Sending exact eBay URL to worker:",
    ebayUrl
  );

  const job =
    await createRemoteEbayJob({
      ebayUrl,
      context
    });

  showEbayCompLoading(
    `Waiting for remote eBay worker: ${item.ebaySearchQuery}`
  );

  const listings =
    await waitForRemoteEbayJob(
      job.jobId
    );

  return {
    jobId:
      job.jobId,

    ebayUrl,

    listings
  };
}

async function aiCheckListing() {
  const analysisRun =
    await getOrCreateMarketplaceAnalysisRun();

  const analysisJobId =
    getCurrentMarketplaceAnalysisJobId();

  await upsertMarketplaceAnalysisJob({
    status:
      "analyzing",

    stage:
      "starting",

    analysisRunId:
      analysisRun.id,

    startedAt:
      Date.now()
  });

  console.log(
    "[PIPELINE JOB] Started:",
    {
      analysisJobId,
      analysisRunId:
        analysisRun.id
    }
  );

  console.log(
    "[IDENTIFICATION] Starting new Marketplace identification pipeline.",
    {
      analysisRunId:
        analysisRun.id
    }
  );

  const button =
    document.getElementById(
      "ebay-comp-checker-btn"
    );

  if (!button) {
    console.error(
      "Could not find eBay comp checker button."
    );
    return;
  }



function getResolvedGoogleIdentity(
  product,
  googleLensResults = []
) {
  const productId =
    String(
      product?.productId || ""
    ).trim();


  if (
    !productId ||
    !Array.isArray(
      googleLensResults
    )
  ) {
    return "";
  }


  const match =
    googleLensResults.find(
      result => {
        const identifiedModel =
          String(
            result?.identifiedModel ||
            ""
          ).trim();


        if (!identifiedModel) {
          return false;
        }


        /*
          Group results contain multiple physical products.

          Do not turn the whole group answer into the
          identity of one product.
        */
        if (
          result?.identificationMode ===
          "group"
        ) {
          return false;
        }


        if (
          result?.ambiguityResolved ===
          false
        ) {
          return false;
        }


        if (
          String(
            result?.targetProductId ||
            ""
          ).trim() !==
          productId
        ) {
          return false;
        }


        /*
          NEW:

          Only allow DataForSEO to bypass the final
          reconciliation uncertainty when its own
          intermediary cleaner was highly confident
          AND strongly converged.

          medium/mixed does NOT qualify.
        */
        const confidence =
          String(
            result
              ?.dataForSeoEvidence
              ?.confidence ||
            ""
          )
            .trim()
            .toLowerCase();


        const consensus =
          String(
            result
              ?.dataForSeoEvidence
              ?.consensus ||
            ""
          )
            .trim()
            .toLowerCase();


        return (
          confidence === "high" &&
          consensus === "strong"
        );
      }
    );


  return String(
    match?.identifiedModel ||
    ""
  ).trim();
}

  /*
    ============================================================
    LOCAL HELPER
    Convert the final reconciled identity into the eBay query
    format expected by the rest of the main extension.
    ============================================================
  */
function buildEbaySearchQuery(
  product,
  fallbackGoogleIdentity = ""
) {
  const brand =
    String(
      product?.brand || ""
    ).trim();

  const model =
    String(
      product?.model || ""
    ).trim();

  const productType =
    String(
      product?.productType || ""
    )
      .trim()
      .toLowerCase();


  const exactGoogleIdentity =
    String(
      fallbackGoogleIdentity || ""
    ).trim();


  let identity = "";


  /*
    ============================================================
    CAMERA LENS

    A reconstructed/partial model such as:

      Canon EF-S 18-55mm f/3.5-5.6 IS

    is NOT automatically an exact identity.

    For lenses we require either:

      1. lensIdentity.canonicalModel from the dedicated resolver

         OR

      2. a high-confidence / strong-consensus DataForSEO identity
         supplied through fallbackGoogleIdentity.

    ============================================================
  */

  if (
    productType ===
    "camera lens"
  ) {
    const canonicalLensModel =
      String(
        product
          ?.lensIdentity
          ?.canonicalModel ||
        ""
      ).trim();


    const exactLensIdentity =
      canonicalLensModel ||
      exactGoogleIdentity;


    if (!exactLensIdentity) {
      console.log(
        "[EBAY QUERY] Skipping unresolved lens:",
        {
          productId:
            product?.productId,

          partialModel:
            model,

          canonicalModel:
            canonicalLensModel,

          dataForSeoIdentity:
            exactGoogleIdentity
        }
      );

      return "";
    }


    const identityAlreadyContainsBrand =
      brand &&
      exactLensIdentity
        .toLowerCase()
        .startsWith(
          brand.toLowerCase()
        );


    identity =
      identityAlreadyContainsBrand
        ? exactLensIdentity
        : [
            brand,
            exactLensIdentity
          ]
            .filter(Boolean)
            .join(" ");
  }


  /*
    ============================================================
    NON-LENS PRODUCTS
    ============================================================
  */

  else if (model) {
    const modelAlreadyContainsBrand =
      brand &&
      model
        .toLowerCase()
        .startsWith(
          brand.toLowerCase()
        );


    identity =
      modelAlreadyContainsBrand
        ? model
        : [
            brand,
            model
          ]
            .filter(Boolean)
            .join(" ");
  }


  /*
    Strong DataForSEO fallback for a non-lens product.
  */

  else {
    identity =
      exactGoogleIdentity;
  }


  if (!identity) {
    return "";
  }


  identity =
    identity
      .replace(/\s+/g, " ")
      .trim();

  const lowerIdentity =
    identity.toLowerCase();

  if (
    productType ===
    "camera lens"
  ) {
    if (
      !lowerIdentity.includes(
        " lens"
      )
    ) {
      identity +=
        " lens";
    }
  }

  else if (
    productType ===
    "camera body"
  ) {
    if (
      !lowerIdentity.includes(
        "body"
      )
    ) {
      identity +=
        " camera body";
    }
  }

  else if (
    productType ===
    "camera"
  ) {
    if (
      !lowerIdentity.includes(
        "camera"
      )
    ) {
      identity +=
        " camera";
    }
  }

  else if (
    productType ===
    "flash"
  ) {
    if (
      !lowerIdentity.includes(
        "flash"
      ) &&
      !lowerIdentity.includes(
        "speedlite"
      ) &&
      !lowerIdentity.includes(
        "speedlight"
      )
    ) {
      identity +=
        " flash";
    }
  }

  return identity
    .replace(/\s+/g, " ")
    .trim();
}


  /*
    ============================================================
    LOCAL HELPER
    Convert one reconciled product into the item structure
    expected by the existing database/eBay pipeline.
    ============================================================
  */
function convertPrimaryProductToCompItem(
  product,
  index,
  condition,
  googleLensResults = []
) {
  const productId =
    String(
      product?.productId ||
      `product_${index + 1}`
    ).trim();


  const fallbackGoogleIdentity =
    getResolvedGoogleIdentity(
      product,
      googleLensResults
    );


  const ebaySearchQuery =
    buildEbaySearchQuery(
      product,
      fallbackGoogleIdentity
    );


  const exactIdentityResolved =
    Boolean(
      String(
        ebaySearchQuery || ""
      ).trim()
    );


  return {
    itemId:
      productId,

    productId,

    brand:
      String(
        product?.brand || ""
      ).trim(),

    model:
      String(
        product?.model || ""
      ).trim(),

    productType:
      String(
        product?.productType || ""
      ).trim(),

    condition:
      condition || "Used",

    confidence:
      0,

    isPrimarySellableItem:
      true,

    exactIdentityResolved,

    ebaySearchQuery,

    negativeSearchTerms:
      [],

    reason:
      exactIdentityResolved
        ? "Exact product identity resolved for valuation."
        : "Physical product detected, but exact commercially distinct identity was not resolved."
  };
}


  button.innerText =
    "Collecting listing...";

  try {
    /*
      ============================================================
      BASE MARKETPLACE DATA
      ============================================================
    */

    const imageUrls =
      await getListingImageUrls();

    if (
      !Array.isArray(
        imageUrls
      ) ||
      !imageUrls.length
    ) {
      throw new Error(
        "No Marketplace listing images were found."
      );
    }

    const screenshotDataUrl =
      await captureVisibleTabScreenshot();

    if (!screenshotDataUrl) {
      throw new Error(
        "Could not capture the Facebook listing screenshot."
      );
    }

    /*
      These DOM values are kept for the downstream deal/eBay
      system.

      They are NOT being used as the main product-identification
      system.
    */
    const title =
  String(
    getListingTitle() || ""
  ).trim();

let description = "";

const facebookPrice =
  parsePriceValue(
    getFacebookAskingPrice()
  );

    console.log(
      "[IDENTIFICATION] Marketplace title:",
      title
    );

    console.log(
      "[IDENTIFICATION] Marketplace description:",
      description
    );

    console.log(
      "[IDENTIFICATION] Facebook price:",
      facebookPrice
    );

    console.log(
      "[IDENTIFICATION] Listing images:",
      imageUrls
    );

    showDebugPreview({
      title,
      description,
      imageUrls,
      screenshotDataUrl
    });


    /*
      ============================================================
      STEP 1
      EXPLICIT SELLER-WRITTEN FACTS
      ============================================================
    */

button.innerText =
  "Reading listing text with Vision OCR...";


const listingOcrResponse =
  await fetchLocalServer(
    "/vision-ocr",
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
          items: [
            {
              key:
                "listing_screenshot",

              imageSource:
                screenshotDataUrl
            }
          ]
        })
    }
  );


const listingOcrData =
  await readJsonSafely(
    listingOcrResponse
  );


if (
  !listingOcrResponse.ok ||
  listingOcrData.error
) {
  throw new LocalServerError(
    listingOcrData,
    "Google Vision listing OCR failed."
  );
}


const listingScreenshotOcr =
  String(
    listingOcrData
      ?.results
      ?.[0]
      ?.text ||
    ""
  ).trim();


console.log(
  "[STEP 1A] Google Vision screenshot OCR:"
);

console.log(
  listingScreenshotOcr
);

/*
  Google Cloud Vision OCR is now the sole source
  of listing description/text evidence.
*/
description =
  listingScreenshotOcr;


/*
  Use Google Cloud Vision OCR exclusively
  for listing textual evidence.
*/
const listingText =
  listingScreenshotOcr;


button.innerText =
  "Analyzing listing facts...";


const factsResponse =
  await fetchLocalServer(
    "/analyze-listing-facts",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

body:
  JSON.stringify({
    listingText
  })
    }
  );


const explicitFacts =
  await readJsonSafely(
    factsResponse
  );

if (!factsResponse.ok) {
  throw new LocalServerError(
    explicitFacts,
    "Listing fact extraction failed."
  );
}

    console.log(
      "[STEP 1] Explicit listing facts:"
    );

    console.log(
      explicitFacts
    );


    /*
      If you later add condition to the new
      /analyze-listing-facts endpoint, this automatically uses it.

      Current mini-extension output does not include condition,
      so normal listings default to Used.
    */
    const allowedConditions =
      new Set([
        "New",
        "Open Box",
        "Used",
        "For parts"
      ]);

    const listingCondition =
      allowedConditions.has(
        explicitFacts?.condition
      )
        ? explicitFacts.condition
        : "Used";


    /*
      ============================================================
      STEP 2
      ANALYZE ALL MARKETPLACE PHOTOS AS GALLERIES
      ============================================================
    */

    button.innerText =
      `Analyzing ${imageUrls.length} image(s)...`;

    const galleryResponse =
      await fetchLocalServer(
        "/analyze-listing-gallery",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              imageUrls
            })
        }
      );

    const galleryData =
      await readJsonSafely(
        galleryResponse
      );

    if (
      !galleryResponse.ok ||
      galleryData.error
    ) {
      throw new LocalServerError(
        galleryData,
        "Marketplace gallery analysis failed."
      );
    }

    const galleries =
      Array.isArray(
        galleryData.galleries
      )
        ? galleryData.galleries
        : [];

    console.log(
      "[STEP 2] Complete gallery result:"
    );

    console.log(
      galleryData
    );


showDebugPreview({
  title,
  description,
  imageUrls,
  screenshotDataUrl,
  galleries
});

    /*
      ============================================================
      STEP 3
      CHOOSE BEST IMAGE FOR EACH PHYSICAL PRODUCT
      ============================================================
    */

    const bestTargets =
      pickBestGoogleTargets(
        galleries,
        imageUrls
      );

    console.log(
      "[STEP 3] Best Google targets:"
    );

    console.log(
      bestTargets
    );

    if (!bestTargets.length) {
      /*
        The tested mini-extension stops here too.

        This prevents continuing to eBay using a product identity
        that never went through the new Google identification
        process.
      */
      const noTargetResult = {
        recommendation:
          "Pass",

        reason:
          "No primary camera product could be mapped to a usable Marketplace image for identification.",

        facebookPrice,

        totalExpectedSalePrice:
          null,

        profitAtAsk:
          null,

        profitAt35:
          null,

        maxBuyPrice:
          null,

        validSoldCount:
          0,

        medianSoldPrice:
          null,

        items:
          []
      };

      showLotCompPanel(
        noTargetResult
      );

      await markMarketplaceAutoAnalysisComplete(
        noTargetResult
      );

      return;
    }


    /*
  ============================================================
  STEP 4A
  GOOGLE CLOUD VISION OCR OF BEST PRODUCT IMAGES
  ============================================================
*/

button.innerText =
  `Reading model markings from ${bestTargets.length} product(s)...`;


/*
  Avoid paying to OCR the same physical image repeatedly.

  Multiple products can use the same Marketplace image,
  so OCR each unique image only once.
*/
const uniqueOcrImages =
  [];

const seenOcrImageUrls =
  new Set();


for (
  const target of bestTargets
) {
  const imageUrl =
    String(
      target?.imageUrl ||
      ""
    ).trim();

  if (
    !imageUrl ||
    seenOcrImageUrls.has(
      imageUrl
    )
  ) {
    continue;
  }

  seenOcrImageUrls.add(
    imageUrl
  );

  uniqueOcrImages.push({
    key:
      `marketplace_image_${target.bestImageIndex}`,

    imageSource:
      imageUrl,

    imageUrl,

    imageIndex:
      target.bestImageIndex
  });
}


const productOcrResponse =
  await fetchLocalServer(
    "/vision-ocr",
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
          items:
            uniqueOcrImages.map(
              item => ({
                key:
                  item.key,

                imageSource:
                  item.imageSource
              })
            )
        })
    }
  );


const productOcrData =
  await readJsonSafely(
    productOcrResponse
  );


if (
  !productOcrResponse.ok ||
  productOcrData.error
) {
  throw new LocalServerError(
    productOcrData,
    "Product-image Vision OCR failed."
  );
}


const ocrTextByKey =
  new Map(
    (
      Array.isArray(
        productOcrData.results
      )
        ? productOcrData.results
        : []
    ).map(
      result => [
        String(
          result?.key ||
          ""
        ),
        String(
          result?.text ||
          ""
        ).trim()
      ]
    )
  );


const productOcrResults =
  bestTargets.map(
    target => {
      const key =
        `marketplace_image_${target.bestImageIndex}`;

      return {
        galleryIndex:
          target.galleryIndex,

        productId:
          target.productId,

        productType:
          target.productType,

        imageIndex:
          target.bestImageIndex,

        imageUrl:
          target.imageUrl,

        modelReadabilityScore:
          target.modelReadabilityScore,

        ocrText:
          ocrTextByKey.get(
            key
          ) || ""
      };
    }
  );


console.log(
  "[STEP 4A] Product OCR results:"
);

console.dir(
  productOcrResults,
  {
    depth: null
  }
);


    /*
      ============================================================
      STEP 5
      FINAL PRODUCT RECONCILIATION
      ============================================================
    */

    button.innerText =
      "Reconciling products...";

     console.log(
  "[DEBUG STEP 4A->5A] OCR-first reconciliation payload:",
  {
    explicitFacts:
      JSON.parse(
        JSON.stringify(
          explicitFacts
        )
      ),

    galleryResults:
      JSON.parse(
        JSON.stringify(
          galleries
        )
      ),

    bestGoogleTargets:
      JSON.parse(
        JSON.stringify(
          bestTargets
        )
      ),

    productOcrResults:
      JSON.parse(
        JSON.stringify(
          productOcrResults
        )
      )
  }
);

const initialIdentificationResponse =
  await fetchLocalServer(
    "/reconcile-primary-products",
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
          listingTitle:
            title,

          listingDescription:
            description,

          listingScreenshotOcr,

          explicitFacts,

          galleryResults:
            galleries,

          bestGoogleTargets:
            bestTargets,

          productOcrResults,

          googleLensResults:
            []
        })
    }
  );


const initialIdentificationData =
  await readJsonSafely(
    initialIdentificationResponse
  );


if (
  !initialIdentificationResponse.ok ||
  initialIdentificationData.error
) {
  throw new LocalServerError(
    initialIdentificationData,
    "OCR-first product reconciliation failed."
  );
}

/*
  ============================================================
  STEP 5A
  DETERMINE WHICH PRODUCTS STILL REQUIRE GOOGLE LENS
  ============================================================
*/

const needsGoogleLens =
  Array.isArray(
    initialIdentificationData
      ?.needsGoogleLens
  )
    ? initialIdentificationData
        .needsGoogleLens
    : [];


const lensFallbackTargets =
  bestTargets.filter(
    target =>
      needsGoogleLens.some(
        unresolved =>
          String(
            unresolved.productId
          ) ===
            String(
              target.productId
            )
      )
  );


console.log(
  "[STEP 5A] Products requiring Google Lens:",
  lensFallbackTargets
);


/*
  If everything was already resolved by seller text + OCR,
  initialIdentificationData is already our final result.
*/
let googleLensResults =
  [];

let finalIdentificationData =
  initialIdentificationData;


/*
  ============================================================
  STEP 4B
  GOOGLE LENS FALLBACK — ONLY UNRESOLVED PRODUCTS
  ============================================================
*/

if (
  lensFallbackTargets.length
) {
  button.innerText =
    `Identifying ${lensFallbackTargets.length} product(s) with Google Lens...`;

  console.log(
    "[GOOGLE LENS ROUTING]",
    {
      targetCount:
        lensFallbackTargets.length,

      targets:
        lensFallbackTargets
    }
  );

button.innerText =
  `Cropping ${lensFallbackTargets.length} unresolved product(s)...`;


const croppedFallbackTargets =
  await prepareDataForSeoCrops(
    lensFallbackTargets,
    initialIdentificationData,
    productOcrResults
  );


console.log(
  "[DATAFORSEO CROP] Prepared fallback targets:"
);

console.dir(
  croppedFallbackTargets,
  {
    depth:
      null
  }
);


button.innerText =
  `Identifying ${croppedFallbackTargets.length} cropped product(s)...`;


/*
  ============================================================
  PARK THIS LISTING WHILE DATAFORSEO WAITS
  ============================================================

  Its tab remains alive and its Promise remains pending.

  We simply mark it as safe for the browse page to open one
  additional Marketplace listing.
*/
await upsertMarketplaceAnalysisJob({
  status:
    "waiting-dataforseo",

  stage:
    "dataforseo",

  parkedAt:
    Date.now()
});


console.log(
  "[PIPELINE JOB] Listing parked for DataForSEO:",
  {
    analysisJobId:
      getCurrentMarketplaceAnalysisJobId(),

    targetCount:
      croppedFallbackTargets.length
  }
);


/*
  Release the browse controller.

  currentListingUrl is currently a SINGLE-listing flag,
  so clear it while this tab remains alive.

  The job registry now becomes the source of truth for
  this parked listing.
*/
{
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_AUTO_STATE_KEY
    );

  const state =
    stored[
      MARKETPLACE_AUTO_STATE_KEY
    ];

  if (state?.running) {
    await chrome.storage.local.set({
      [MARKETPLACE_AUTO_STATE_KEY]: {
        ...state,

        currentListingUrl:
          "",

        waitingForAnalysis:
          false,

        analysisDone:
          false,

        /*
          Tell the browse page it may continue.
        */
        dataForSeoListingParked:
          true,

        dataForSeoListingParkedAt:
          Date.now()
      }
    });
  }
}


/*
  THIS REQUEST STILL WAITS HERE.

  But while it waits, the browse tab may open Listing B.
*/
googleLensResults =
  await runLocalGoogleLensTargets(
    croppedFallbackTargets
  );


console.log(
  "[PIPELINE JOB] DataForSEO returned:",
  {
    analysisJobId:
      getCurrentMarketplaceAnalysisJobId()
  }
);


await upsertMarketplaceAnalysisJob({
  status:
    "resume-ready",

  stage:
    "post-dataforseo",

  dataForSeoReturnedAt:
    Date.now()
});

  console.log(
    "[STEP 4B] Google Lens fallback results:"
  );

  console.dir(
    googleLensResults,
    {
      depth: null
    }
  );
  


  console.log(
    "[STEP 4B] Google Lens fallback results:"
  );

  console.dir(
    googleLensResults,
    {
      depth: null
    }
  );


  /*
    ============================================================
    STEP 5B
    FINAL RECONCILIATION WITH GOOGLE LENS EVIDENCE
    ============================================================
  */

  button.innerText =
    "Finalizing product identities...";


  const secondPassResponse =
    await fetchLocalServer(
      "/reconcile-primary-products",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            listingTitle:
              title,

            listingDescription:
              description,

            listingScreenshotOcr,

            explicitFacts,

            galleryResults:
              galleries,

            bestGoogleTargets:
              bestTargets,

        productOcrResults,

/*
  Preserve the exact state established BEFORE
  DataForSEO ran.

  The server uses this as the baseline so weak
  visual-search evidence cannot mutate known facts.
*/
preDataForSeoPrimaryProducts:
  Array.isArray(
    initialIdentificationData
      ?.primaryProducts
  )
    ? initialIdentificationData
        .primaryProducts
    : [],

    preDataForSeoLensfunCandidates:
  Array.isArray(
    initialIdentificationData
      ?.lensfunCandidateConstraints
  )
    ? initialIdentificationData
        .lensfunCandidateConstraints
    : [],

googleLensResults
          })
      }
    );


  const secondPassData =
    await readJsonSafely(
      secondPassResponse
    );


  if (
    !secondPassResponse.ok ||
    secondPassData.error
  ) {
    throw new LocalServerError(
      secondPassData,
      "Final Lens-assisted reconciliation failed."
    );
  }


  finalIdentificationData =
    secondPassData;
}

/*
  SERIALIZE THE FINAL PHASE FOR EVERY LISTING.

  This protects the shared database/eBay state even when
  this listing did not require DataForSEO.
*/
await acquireMarketplaceFinishLock();


await upsertMarketplaceAnalysisJob({
  status:
    "finishing",

  stage:
    "final-database-ebay"
});


/*
  ============================================================
  FINAL PRIMARY PRODUCTS
  ============================================================
*/

/*
  ============================================================
  FINAL PRIMARY PRODUCTS
  ============================================================
*/

const reconciledProducts =
  Array.isArray(
    finalIdentificationData
      ?.primaryProducts
  )
    ? finalIdentificationData
        .primaryProducts
    : [];

    console.log(
      "[STEP 5] FINAL PRIMARY PRODUCTS:"
    );

    console.table(
      reconciledProducts
    );

    await chrome.storage.local.set({
  marketplaceFinalPrimaryProducts:
    reconciledProducts
});


    /*
      ============================================================
      CONVERT NEW IDENTIFICATION RESULT INTO THE EXISTING
      DATABASE / EBAY ITEM FORMAT
      ============================================================
    */

    const primaryItems =
      reconciledProducts
        .slice(
          0,
          10
        )
        .map(
          (
            product,
            index
          ) =>
            convertPrimaryProductToCompItem(
  product,
  index,
  listingCondition,
  googleLensResults
)
        );

        console.log(
  "[DEBUG STEP 5B] Primary items after conversion:",
  primaryItems.map(
    item => ({
      itemId:
        item?.itemId,

      productId:
        item?.productId,

      brand:
        item?.brand,

      model:
        item?.model,

      productType:
        item?.productType,

      ebaySearchQuery:
        item?.ebaySearchQuery,

      condition:
        item?.condition
    })
  )
);

    /*
      Compatibility object for downstream functions that still
      expect the old "data" object.

      This is NOT the old identification result.
    */
    const data = {
      listingTitle:
        title,

      listingDescription:
        description,

      askingPrice:
        facebookPrice,

      items:
        primaryItems,

      listingType:
        primaryItems.length > 1
          ? "bundle"
          : "single_item",

      exceedsPrimaryItemLimit:
        reconciledProducts.length > 5,

      ignoredItems:
        [],

      cameraAnalysis: {
        isCameraListing:
          primaryItems.some(
            item => {
              const type =
                String(
                  item.productType || ""
                )
                  .toLowerCase();

              return (
                type.includes(
                  "camera"
                ) ||
                type.includes(
                  "lens"
                )
              );
            }
          )
      }
    };


    showDebugPreview({
      title,
      description,
      imageUrls,
      screenshotDataUrl,

      aiResult: {
        explicitFacts,

        galleryData,

        bestGoogleTargets:
          bestTargets,

        googleLensResults,

        primaryProducts:
          reconciledProducts,

        compItems:
          primaryItems
      }
    });


    /*
      ============================================================
      IMMEDIATE NON-CAMERA SKIP
      ============================================================
    */

    if (
      !listingLooksLikeCameraOrLens(
        data,
        primaryItems
      )
    ) {
      const passResult = {
        recommendation:
          "Pass",

        reason:
          "Immediate skip: the new identification pipeline did not detect a camera or camera lens in this listing.",

        facebookPrice,

        totalExpectedSalePrice:
          null,

        profitAtAsk:
          null,

        profitAt35:
          null,

        maxBuyPrice:
          null,

        validSoldCount:
          0,

        medianSoldPrice:
          null,

        items:
          primaryItems,

        ignoredItems:
          [],

        cameraAnalysis:
          data.cameraAnalysis
      };

      console.log(
        "Immediate skip because listing is not camera/lens:",
        passResult
      );

      showLotCompPanel(
        passResult
      );

      await markMarketplaceAutoAnalysisComplete(
        passResult
      );

      return;
    }


    /*
      ============================================================
      PRIMARY ITEM LIMIT
      ============================================================
    */

    if (
      reconciledProducts.length > 5 ||
      primaryItems.length > 5
    ) {
      const passResult = {
        recommendation:
          "Pass",

        reason:
          `Immediate pass: listing has ${reconciledProducts.length} primary sellable items. Maximum allowed is 5.`,

        facebookPrice,

        totalExpectedSalePrice:
          null,

        profitAtAsk:
          null,

        profitAt35:
          null,

        maxBuyPrice:
          null,

        items:
          primaryItems.map(
            item => ({
              itemId:
                item.itemId || "",

              itemName:
                item.ebaySearchQuery ||
                `${item.brand || ""} ${item.model || ""} ${item.productType || ""}`
                  .replace(
                    /\s+/g,
                    " "
                  )
                  .trim(),

              brand:
                item.brand || "",

              model:
                item.model || "",

              productType:
                item.productType || "",

              condition:
                item.condition || "",

              validSoldCount:
                0,

              includedExpectedSalePrice:
                null,

              status:
                "Excluded",

              reason:
                "Excluded because listing exceeded the 5-primary-item limit."
            })
          ),

        ignoredItems:
          []
      };

      showLotCompPanel(
        passResult
      );

      const stored =
        await chrome.storage.local.get(
          MARKETPLACE_AUTO_STATE_KEY
        );

      await markMarketplaceAutoAnalysisComplete(
  passResult
);

return;
    }


    if (!primaryItems.length) {
      const noItemsResult = {
        recommendation:
          "Pass",

        reason:
          "The new identification pipeline did not identify any primary sellable camera products.",

        facebookPrice,

        items:
          []
      };

      showLotCompPanel(
        noItemsResult
      );

      await markMarketplaceAutoAnalysisComplete(
        noItemsResult
      );

      return;
    }


    /*
      ============================================================
      PRODUCT DATABASE LOOKUP

      The new identification pipeline is now COMPLETE.

      From this point onward there is NO additional Google Lens
      verification and NO SerpApi verification.
      ============================================================
    */

    button.innerText =
      "Checking product database...";

   let databaseLookups = [];

if (
  !TESTING_MODE
) {
  button.innerText =
    "Checking product database...";

  const databaseResponse =
    await fetchLocalServer(
      "/lookup-product-values",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            items:
              primaryItems
          })
      }
    );

  const databaseData =
    await readJsonSafely(
      databaseResponse
    );

  if (
    !databaseResponse.ok ||
    databaseData.error
  ) {
    throw new LocalServerError(
      databaseData,
      "Product database lookup failed."
    );
  }

  databaseLookups =
    Array.isArray(
      databaseData.results
    )
      ? databaseData.results
      : [];

}else {
  console.log(
    "[TEST MODE] Global product resale database disabled. Every resolved product will be tested through eBay."
  );
}

const databaseResults = [];
const itemsNeedingEbay = [];

for (
  let index = 0;
  index < primaryItems.length;
  index += 1
) {
const item =
  primaryItems[index];

const initialLookup =
  databaseLookups.find(
    entry =>
      Number(entry.index) ===
      index
  );

console.log(
  "[DEBUG EBAY QUEUE A] Evaluating primary item:",
  {
    index,

    productId:
      item?.productId,

    brand:
      item?.brand,

    model:
      item?.model,

    productType:
      item?.productType,

    ebaySearchQuery:
      item?.ebaySearchQuery,

    databaseLookup:
      initialLookup
  }
);

  /*
    DATABASE HIT
  */
  if (
    initialLookup?.found === true &&
    initialLookup
      .estimatedResalePrice != null
  ) {
    const storedPrice =
      Number(
        initialLookup
          .estimatedResalePrice
      );

    console.log(
      "[PRODUCT DATABASE] HIT:",
      initialLookup.canonicalName,
      "$" + storedPrice
    );

    databaseResults.push({
      item,

      result: {
        source:
          "database",

        expectedSalePrice:
          storedPrice,

        medianSoldPrice:
          null,

        validSoldCount:
          0,

        databaseCanonicalName:
          initialLookup.canonicalName,

        recommendation:
          "Database Value",

       reason:
  "Estimated resale value loaded from global Supabase product database."
      }
    });

    continue;
  }

  /*
    DATABASE MISS

    Product identity has ALREADY been through
    the new Google/reconciliation pipeline.

    No second verification.
  */
  console.log(
    "[PRODUCT DATABASE] MISS:",
    item.ebaySearchQuery ||
    `${item.brand || ""} ${item.model || ""}`
  );

  itemsNeedingEbay.push(
    item
  );
}

    /*
      ============================================================
      REMOVE UNRESOLVED DB MISSES FROM EBAY QUEUE

      We never open a generic eBay query if the final model
      was unresolved.
      ============================================================
    */

    const unresolvedDatabaseMissResults =
      [];

console.log(
  "[DEBUG EBAY QUEUE B] Items needing eBay BEFORE filtering:",
  itemsNeedingEbay.map(
    item => ({
      productId:
        item?.productId,

      brand:
        item?.brand,

      model:
        item?.model,

      productType:
        item?.productType,

      ebaySearchQuery:
        item?.ebaySearchQuery
    })
  )
);

    const compableItemsNeedingEbay =
      itemsNeedingEbay.filter(
        item => {
          const query =
            String(
              item
                ?.ebaySearchQuery ||
              ""
            ).trim();

          if (query) {
            return true;
          }

          console.log(
            "[PRODUCT DATABASE] DB miss has no resolved eBay query. Skipping:",
            item
          );

          unresolvedDatabaseMissResults.push({
            item,

            result: {
              source:
                "unresolved",

              expectedSalePrice:
                null,

              medianSoldPrice:
                null,

              validSoldCount:
                0,

              recommendation:
                "Unresolved",

              reason:
                "Product was not found in the database and the new identification pipeline did not resolve an exact model for an eBay sold search."
            }
          });

          return false;
        }
      );

      console.log(
  "[DEBUG EBAY QUEUE C] Final eBay-compable items:",
  compableItemsNeedingEbay.map(
    item => ({
      productId:
        item?.productId,

      brand:
        item?.brand,

      model:
        item?.model,

      productType:
        item?.productType,

      ebaySearchQuery:
        item?.ebaySearchQuery
    })
  )
);

console.log(
  "[DEBUG EBAY QUEUE D] Removed unresolved items:",
  unresolvedDatabaseMissResults.map(
    entry => ({
      productId:
        entry?.item?.productId,

      brand:
        entry?.item?.brand,

      model:
        entry?.item?.model,

      ebaySearchQuery:
        entry?.item
          ?.ebaySearchQuery,

      reason:
        entry?.result?.reason
    })
  )
);


    /*
      ============================================================
      CREATE NORMAL EBAY COMP CONTEXT
      ============================================================
    */

    const facebookUrl =
      getCurrentFacebookListingUrl()
        .split("?")[0];

const ebayExecutionMode =
  !TESTING_MODE
    ? "api-active"
    : shouldUseRemoteEbayForListing()
      ? "remote"
      : "local";
      

console.log(
  "[EBAY ROUTING] Marketplace listing assigned:",
  {
    facebookUrl,
    ebayExecutionMode,
    ebayItems:
      compableItemsNeedingEbay
        .length
  }
);

await chrome.storage.local.set({
  ebayCompContext: {
    mode:
      primaryItems.length > 1
        ? "bundle"
        : "single",

    /*
      This is the important new field.

      It stays fixed for the entire Marketplace listing.
    */
    ebayExecutionMode,

      testingMode:
      TESTING_MODE,

    originalFacebookTitle:
      title,

    facebookDescription:
      description,

    facebookPrice,

    facebookUrl,

    imageUrls:
      Array.isArray(
        imageUrls
      )
        ? imageUrls
        : [],

    ignoredItems:
      [],

    items:
      compableItemsNeedingEbay,

    currentItemIndex:
      0,

    results: [
      ...databaseResults,
      ...unresolvedDatabaseMissResults
    ],

    createdAt:
      Date.now()
  }
});

    const firstItem =
      compableItemsNeedingEbay[0];

      console.log(
  "[DEBUG EBAY QUEUE E] firstItem selected for eBay:",
  firstItem || null
);

console.log(
  "[DEBUG EBAY QUEUE F] Queue summary:",
  {
    primaryItems:
      primaryItems.length,

    databaseResults:
      databaseResults.length,

    itemsNeedingEbay:
      itemsNeedingEbay.length,

    compableItemsNeedingEbay:
      compableItemsNeedingEbay.length,

    unresolvedDatabaseMissResults:
      unresolvedDatabaseMissResults.length,

    firstItemExists:
      Boolean(
        firstItem
      )
  }
);

    const allPrimaryItemsFoundInDatabase =
      primaryItems.length > 0 &&
      databaseResults.length ===
        primaryItems.length;


    /*
      ============================================================
      ALL PRODUCTS FOUND IN DATABASE
      ============================================================
    */

    if (
      allPrimaryItemsFoundInDatabase
    ) {
      console.log(
        "[PRODUCT DATABASE] All primary products found. Skipping eBay completely."
      );

      const storedContext =
        await chrome.storage.local.get(
          "ebayCompContext"
        );

      const completeContext =
        storedContext
          .ebayCompContext;

      const finalResponse =
        await fetchLocalServer(
          "/evaluate-lot",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                context:
                  completeContext
              })
          }
        );

      const finalResult =
        await readJsonSafely(
          finalResponse
        );

      if (
        !finalResponse.ok ||
        finalResult.error
      ) {
        throw new LocalServerError(
          finalResult,
          "Database-only lot evaluation failed."
        );
      }

      const databaseFinalResult = {
        ...finalResult,

        databaseOnly:
          true,

        reason:
          `All primary products were found in the local product database. ` +
          `${finalResult.reason || ""}`
      };

      console.log(
        "[PRODUCT DATABASE] Database-only final result:",
        databaseFinalResult
      );

      /*
        No finalLensVerificationDone flag anymore.

        The new identification pipeline already performed
        identification before the database lookup.
      */

      if (
        String(
          databaseFinalResult
            .recommendation ||
          ""
        )
          .trim()
          .toLowerCase() ===
        "scam"
      ) {
        await saveScamListing({
          context:
            completeContext,

          result:
            databaseFinalResult
        });
      }

      await saveDealToLibrary({
        context:
          completeContext,

        result:
          databaseFinalResult
      });

      await markMarketplaceAutoAnalysisComplete(
        databaseFinalResult
      );

      showLotCompPanel(
        databaseFinalResult
      );

      return;
    }


    /*
      ============================================================
      NO EBAY-SEARCHABLE ITEMS REMAIN

      This happens when one or more models could not be resolved
      and were also absent from the product database.
      ============================================================
    */

    if (!firstItem) {
      console.warn(
        "[PRODUCT DATABASE] No eBay-compable items remain, and not all primary products have database values.",
        {
          primaryItemCount:
            primaryItems.length,

          databaseResultCount:
            databaseResults.length,

          unresolvedResultCount:
            unresolvedDatabaseMissResults
              .length,

          itemsNeedingEbayCount:
            itemsNeedingEbay.length,

          compableItemsNeedingEbayCount:
            compableItemsNeedingEbay
              .length
        }
      );

      const unresolvedResult = {
        recommendation:
          "Pass",

        facebookPrice,

        totalExpectedSalePrice:
          databaseResults.reduce(
            (
              sum,
              entry
            ) =>
              sum +
              Number(
                entry
                  ?.result
                  ?.expectedSalePrice ||
                0
              ),
            0
          ),

        reason:
          "One or more primary products were not found in the local product database and the new identification pipeline did not produce a usable exact-model eBay query.",

        items: [
          ...databaseResults,
          ...unresolvedDatabaseMissResults
        ]
      };

      await markMarketplaceAutoAnalysisComplete(
        unresolvedResult
      );

      showLotCompPanel(
        unresolvedResult
      );

      return;
    }


/*
  ============================================================
  NORMAL MODE — ACTIVE EBAY API ONLY
  ============================================================
*/
if (
  !TESTING_MODE
) {
  console.log(
    "[EBAY MODE] Normal scanner: active listings only."
  );

  button.innerText =
    "Checking active eBay listings...";

  await runActiveEbayApiWorkflow(
    button
  );

  return;
}
    /*
      ============================================================
      START EXISTING EBAY SOLD-COMP WORKFLOW

      Notice there is NO:
        needsVisualSearch check
        force-lens-verification
        SerpApi
        second identification pass

      The product identity is considered final at this point.
      ============================================================
    */

    /*
  ============================================================
  START EBAY SOLD-COMP WORKFLOW
  ============================================================
*/

const storedEbayContext =
  await chrome.storage.local.get(
    "ebayCompContext"
  );

const activeEbayContext =
  storedEbayContext
    .ebayCompContext;

/*
  ------------------------------------------------------------
  REMOTE LISTING
  ------------------------------------------------------------
*/

if (
  activeEbayContext
    ?.ebayExecutionMode ===
  "remote"
) {
  console.log(
    "[EBAY ROUTING] This Marketplace listing is using the remote eBay worker."
  );

  button.innerText =
    "Waiting for remote eBay worker...";

  await runRemoteEbayCompWorkflow();

  return;
}

/*
  ------------------------------------------------------------
  NORMAL LOCAL LISTING
  ------------------------------------------------------------
*/

console.log(
  "[EBAY ROUTING] This Marketplace listing is using normal local eBay tabs."
);

button.innerText =
  "Opening eBay comps...";

const opened =
  openEbaySoldSearch(
    firstItem
      .ebaySearchQuery,

    firstItem.condition,

    firstItem
      .negativeSearchTerms
  );

if (!opened) {
  const unresolvedResult = {
    recommendation:
      "Pass",

    facebookPrice,

    reason:
      "The identified product did not have a usable eBay search query.",

    item:
      firstItem
  };

  await markMarketplaceAutoAnalysisComplete(
    unresolvedResult
  );

  showLotCompPanel(
    unresolvedResult
  );

  return;
}

    if (!opened) {
      const unresolvedResult = {
        recommendation:
          "Pass",

        facebookPrice,

        reason:
          "The identified product did not have a usable eBay search query.",

        item:
          firstItem
      };

      await markMarketplaceAutoAnalysisComplete(
        unresolvedResult
      );

      showLotCompPanel(
        unresolvedResult
      );

      return;
    }

  } catch (error) {
    console.error(
      error
    );

    const shouldRestartForJson =
      error
        ?.retryEntireListing ===
        true ||
      error?.code ===
        "MALFORMED_AI_JSON" ||
      error?.code ===
        "MALFORMED_SERVER_JSON";

    if (
      shouldRestartForJson
    ) {
      await restartEntireFacebookListingScanBecauseMalformedJson({
        step:
          error.step ||
          "Product identification",

        errorMessage:
          error.message ||
          ""
      });

      return;
    }

    const stored =
      await chrome.storage.local.get(
        MARKETPLACE_AUTO_STATE_KEY
      );

    const state =
      stored[
        MARKETPLACE_AUTO_STATE_KEY
      ];

if (state?.running) {
  const errorResult = {
    recommendation:
      "Error",

    reason:
      error.message ||
      "Could not complete listing analysis."
  };

  await markMarketplaceAutoAnalysisComplete(
    errorResult
  );

  return;
}

    alert(
      error.message ||
      "Could not reach local AI server. Make sure npm.cmd run dev is running."
    );

  } finally {
    button.innerText =
      "AI Check eBay Sold";
  }
}

function parseEbayPrice(text) {
  if (!text) return null;

  // Skip price ranges for now.
  if (text.includes("to")) return null;

  const match = text.match(/\$[\d,]+(\.\d{2})?/);
  if (!match) return null;

  return Number(match[0].replace("$", "").replace(/,/g, ""));
}

function parseEbaySoldDate(text) {
  if (!text) return null;

  const cleaned = text.replace(/\s+/g, " ");

  const match = cleaned.match(/Sold\s+([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})?/i);

  if (!match) return null;

  const month = match[1];
  const day = match[2];
  const year = match[3] || new Date().getFullYear();

  const date = new Date(`${month} ${day}, ${year}`);

  if (Number.isNaN(date.getTime())) return null;

  if (!match[3] && date > new Date()) {
    date.setFullYear(date.getFullYear() - 1);
  }

  return date.toISOString();
}

function formatSessionDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

const MARKETPLACE_AUTO_STATS_PANEL_ID = "marketplace-auto-stats-panel";
let marketplaceAutoStatsIntervalId = null;

function formatAutoStatsClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function getAutoStatsPanelStatusText(state) {
  if (!state?.running) return "Stopped";
  if (state.waitingForAnalysis) return "Analyzing listing";
  if (state.currentListingUrl) return "Opening listing";
  return "Scanning";
}

function ensureMarketplaceAutoStatsPanel() {
  let panel = document.getElementById(MARKETPLACE_AUTO_STATS_PANEL_ID);

  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = MARKETPLACE_AUTO_STATS_PANEL_ID;

  panel.style.position = "fixed";
  panel.style.left = "18px";
  panel.style.top = "120px";
  panel.style.width = "215px";
  panel.style.zIndex = "999999";
  panel.style.background = "#111";
  panel.style.color = "#fff";
  panel.style.border = "1px solid rgba(255,255,255,0.18)";
  panel.style.borderRadius = "12px";
  panel.style.padding = "12px";
  panel.style.fontFamily = "Arial, sans-serif";
  panel.style.fontSize = "12px";
  panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";

  document.body.appendChild(panel);
  return panel;
}

function removeMarketplaceAutoStatsPanel() {
  const panel = document.getElementById(MARKETPLACE_AUTO_STATS_PANEL_ID);
  if (panel) panel.remove();
}

function renderMarketplaceAutoStatsPanel(state) {
  if (!state?.running) {
    removeMarketplaceAutoStatsPanel();
    return;
  }

  const panel = ensureMarketplaceAutoStatsPanel();

  const sessionLog = state.sessionLog || {};
  const startedAt = sessionLog.startedAt || state.createdAt || Date.now();

  const elapsedMs = Date.now() - startedAt;
  const clickedListings =
  Number(
    sessionLog.clickedListings || 0
  );

const hitsFound =
  Number(
    sessionLog.hitsFound || 0
  );

const outreachQueued =
  Number(
    sessionLog.outreachQueued || 0
  );

  const currentSearchTerm =
  state.currentSearchTerm ||
  getMarketplaceSearchTermFromUrl(
    state.listUrl ||
    window.location.href
  ) ||
  "Not detected";

const isRandomKeywordScan =
  state.scanMode ===
  MARKETPLACE_RANDOM_KEYWORD_MODE;

  const remainingText = state.stopAt
    ? formatAutoStatsClock(Math.max(0, state.stopAt - Date.now()))
    : "No timer";

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px;">
      <div style="font-weight:800; font-size:14px;">Auto Scan</div>
      <div style="font-size:10px; color:#9ee493; font-weight:700;">LIVE</div>
    </div>

    <div style="font-size:11px; color:#bbb; margin-bottom:10px;">
      ${escapeHtml(getAutoStatsPanelStatusText(state))}
    </div>

    <div style="display:grid; gap:8px;">
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span style="color:#bbb;">Elapsed</span>
        <b>${escapeHtml(formatAutoStatsClock(elapsedMs))}</b>
      </div>

      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span style="color:#bbb;">Listings clicked</span>
        <b>${clickedListings}</b>
      </div>

      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span style="color:#bbb;">Hits found</span>
        <b>${hitsFound}</b>
      </div>

      <div style="display:flex; justify-content:space-between; gap:8px;">
  <span style="color:#bbb;">Outreach queued</span>
  <b>${outreachQueued}</b>
</div>

      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span style="color:#bbb;">Remaining</span>
        <b>${escapeHtml(remainingText)}</b>
      </div>

      ${
  isRandomKeywordScan
    ? `
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span style="color:#bbb;">Search term</span>
        <b style="max-width:120px; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${escapeHtml(currentSearchTerm)}
        </b>
      </div>

      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span style="color:#bbb;">Term switches</span>
        <b>${Number(state.searchSwitchCount || 0)}</b>
      </div>
    `
    : ""
}
    </div>
  `;
}

async function refreshMarketplaceAutoStatsPanel() {
  if (
    typeof chrome === "undefined" ||
    !chrome.storage?.local
  ) {
    return false;
  }

  try {
    const stored =
      await chrome.storage.local.get(
        MARKETPLACE_AUTO_STATE_KEY
      );

    const state =
      stored[
        MARKETPLACE_AUTO_STATE_KEY
      ];

    renderMarketplaceAutoStatsPanel(
      state
    );

    return true;

  } catch (error) {
    if (
      isExtensionContextInvalidated(
        error
      )
    ) {
      /*
        The extension was reloaded.

        The old content script cannot be repaired;
        the tab must be refreshed.
      */
      if (
        marketplaceAutoStatsIntervalId
      ) {
        clearInterval(
          marketplaceAutoStatsIntervalId
        );

        marketplaceAutoStatsIntervalId =
          null;
      }

      console.warn(
        "Marketplace stats loop stopped because the extension was reloaded. Refresh this tab."
      );

      return false;
    }

    console.warn(
      "Could not refresh Marketplace stats:",
      error
    );

    return false;
  }
}

function startMarketplaceAutoStatsPanelLoop() {
  if (marketplaceAutoStatsIntervalId) return;

  refreshMarketplaceAutoStatsPanel();

 void refreshMarketplaceAutoStatsPanel();

marketplaceAutoStatsIntervalId =
  setInterval(
    () => {
      void refreshMarketplaceAutoStatsPanel();
    },
    1000
  );

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes[MARKETPLACE_AUTO_STATE_KEY]) return;

      renderMarketplaceAutoStatsPanel(changes[MARKETPLACE_AUTO_STATE_KEY].newValue);
    });
  }
}

function extractEbaySoldListings() {
  const itemLinks = Array.from(document.querySelectorAll("a[href*='/itm/']"));

  console.log("eBay item links found:", itemLinks.length);

  function findListingContainer(link) {
    let node = link;

    for (let i = 0; i < 8; i++) {
      if (!node) return null;

      const text = node.innerText || "";

      const hasSold = /Sold\s+[A-Za-z]{3,9}\s+\d{1,2}/i.test(text);
      const hasPrice = /\$[\d,]+(\.\d{2})?/.test(text);
      const textLongEnough = text.length > 40;

      if (hasSold && hasPrice && textLongEnough) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  const containers = itemLinks
    .map(link => findListingContainer(link))
    .filter(Boolean);

  const uniqueContainers = [...new Set(containers)];

  console.log("eBay listing containers found:", uniqueContainers.length);

  const listings = uniqueContainers.map(container => {
    const allText = container.innerText || "";

    const linkEl =
      container.querySelector("a[href*='/itm/']") ||
      null;

    let title =
      linkEl?.innerText?.trim() ||
      linkEl?.getAttribute("aria-label")?.trim() ||
      "";

    title = title
      .replace(/\s+/g, " ")
      .replace(/^Opens in a new window or tab\s*/i, "")
      .trim();

    const priceMatch = allText.match(/\$[\d,]+(\.\d{2})?/);
    const priceText = priceMatch ? priceMatch[0] : "";
    const price = parseEbayPrice(priceText);

    const soldDate = parseEbaySoldDate(allText);

 let condition = "";

const conditionMatch = allText.match(
  /\b(Open Box|Used|Pre-Owned|Parts Only|For parts or not working|For parts|Not Working|Brand New|New other|New with defects)\b/i
);

if (conditionMatch) {
  condition = conditionMatch[0];

  // eBay "New Listing" is not item condition.
  if (/^new$/i.test(condition) && /new listing/i.test(allText)) {
    condition = "";
  }
}

    const imageUrl =
      container.querySelector("img")?.src ||
      "";

    const link =
      linkEl?.href ||
      "";

    const bestOfferAccepted = /best offer accepted/i.test(allText);

return {
  title,
  price,
  priceText,
  condition,
  soldDate,
  link,
  imageUrl,
  bestOfferAccepted,
  rawText: allText.slice(0, 800)
};
  });

  console.log("Raw extracted listings before cleanup:", listings);
  console.table(listings.map(item => ({
    title: item.title,
    price: item.price,
    condition: item.condition,
    soldDate: item.soldDate
  })));

  const cleanedListings = listings
    .filter(item => item.title)
    .filter(item => item.price)
    .filter(item => item.soldDate)
    .filter(item => !item.title.toLowerCase().includes("shop on ebay"))
    .filter(item => !item.title.toLowerCase().includes("results matching fewer words"))
    .slice(0, 60);

  console.log("Cleaned eBay listings:", cleanedListings);
  console.table(cleanedListings.map(item => ({
    title: item.title,
    price: item.price,
    condition: item.condition,
    soldDate: item.soldDate
  })));

  return cleanedListings;
}

function showEbayCompPanel(result) {
  const existing = document.getElementById("ebay-comp-result-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "ebay-comp-result-panel";

  const recommendation = result.recommendation || "Unknown";
  const debug = result.debugCounts || {};

  function money(value) {
    if (value === null || value === undefined) return "N/A";

    const num = Number(value);
    if (Number.isNaN(num)) return "N/A";

    return "$" + num.toFixed(2).replace(/\.00$/, "");
  }

  const medianEligibleCount =
    result.medianEligibleCount ??
    debug.medianEligibleCount ??
    null;

  const bestOfferExcludedCount =
    result.bestOfferExcludedCount ??
    debug.bestOfferExcludedCount ??
    0;

  const removedByAiFilter =
    result.removedByAiFilter ??
    debug.removedByAiFilter ??
    null;

  const priceLow =
    result.lowPrice ??
    debug.priceLow ??
    null;

  const priceHigh =
    result.highPrice ??
    debug.priceHigh ??
    null;

  const hasDebug =
    result.debugCounts ||
    priceLow !== null ||
    priceHigh !== null ||
    bestOfferExcludedCount !== null;

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div style="font-weight:700; font-size:14px;">eBay Comp Analysis</div>
      <button id="ebay-comp-result-close" style="border:none; background:#eee; padding:4px 8px; border-radius:6px; cursor:pointer;">Close</button>
    </div>

    <hr style="margin:10px 0;" />

    <div style="font-size:13px; font-weight:700;">Status</div>
    <div style="font-size:20px; font-weight:800; margin-bottom:10px;">${escapeHtml(recommendation)}</div>

    <div><b>Target:</b> ${escapeHtml(result.targetProduct || "")}</div>
    <div><b>Condition:</b> ${escapeHtml(result.condition || "N/A")}</div>

    <hr style="margin:10px 0;" />

    <div><b>Valid sold comps last 90 days:</b> ${result.validSoldCount ?? "N/A"}</div>
    <div><b>Median sold price:</b> ${money(result.medianSoldPrice)}</div>
    ${result.expectedSalePrice != null ? `<div><b>Estimated resale value:</b> ${money(result.expectedSalePrice)}</div>` : ""}

    ${hasDebug ? `
      <hr style="margin:10px 0;" />
      <div style="font-size:12px; font-weight:700;">Debug</div>
      <div>Scraped from eBay: ${debug.scrapedListings ?? "N/A"}</div>
      <div>Within 90 days: ${debug.recentListings ?? "N/A"}</div>
      <div>Sent to AI cleanup: ${debug.sentToAiCleanup ?? "N/A"}</div>
      <div>Removed by AI cleanup: ${removedByAiFilter ?? "N/A"}</div>
      <div>Comps used for median: ${medianEligibleCount ?? "N/A"}</div>
      <div>Best Offer excluded from median: ${bestOfferExcludedCount ?? 0}</div>
      <div>Comp price range: ${
        priceLow !== null && priceHigh !== null
          ? `${money(priceLow)} – ${money(priceHigh)}`
          : "N/A"
      }</div>
    ` : ""}

    <hr style="margin:10px 0;" />

    <div style="font-size:12px; font-weight:700;">Reason</div>
    <div style="font-size:12px; margin-bottom:10px;">${escapeHtml(result.reason || "")}</div>

    <details>
      <summary style="cursor:pointer;">Show valid comps</summary>
      <div style="margin-top:8px; max-height:260px; overflow:auto;">
        ${(result.validComps || []).map(comp => `
          <div style="border-bottom:1px solid #eee; padding:6px 0;">
            <div style="font-size:12px;">${escapeHtml(comp.title)}</div>
            <div style="font-size:12px;">
              <b>${money(comp.price)}</b> ${escapeHtml(comp.soldDate || "")}
              ${comp.bestOfferAccepted ? `<span style="color:#b45309;"> Best Offer - excluded from median</span>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    </details>
  `;

  document.body.appendChild(panel);

  document.getElementById("ebay-comp-result-close").onclick = () => {
    panel.remove();
  };
}

function showLotCompPanel(result) {
  const existing = document.getElementById("ebay-comp-result-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "ebay-comp-result-panel";

  const itemRows = (result.items || []).map((entry, index) => `
    <div style="border-bottom:1px solid #eee; padding:8px 0;">
      <div style="font-weight:700;">${index + 1}. ${escapeHtml(entry.itemName || "")}</div>
      <div><b>Condition:</b> ${escapeHtml(entry.condition || "")}</div>
     <div><b>Estimated resale value:</b> ${entry.includedExpectedSalePrice != null ? "$" + entry.includedExpectedSalePrice : "Excluded"}</div>
     <div>
  <b>Comp count:</b>
  ${
    entry.validActiveCount ||
    entry.validSoldCount ||
    0
  }
</div>
      <div><b>Status:</b> ${escapeHtml(entry.status || "")}</div>
      <div style="font-size:11px; color:#555;">${escapeHtml(entry.reason || "")}</div>
    </div>

    <div><b>Standard deviation:</b> ${
  entry.priceStandardDeviation != null
    ? "$" + Number(entry.priceStandardDeviation).toFixed(2).replace(/\.00$/, "")
    : "N/A"
}</div>
  `).join("");

  

  const ignoredRows = (result.ignoredItems || []).map(item => `
    <div style="font-size:11px; color:#555;">
      ${escapeHtml(item.name || "")}: ${escapeHtml(item.reason || "")}
    </div>
  `).join("");

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div style="font-weight:700; font-size:14px;">Lot Comp Analysis</div>
      <button id="ebay-comp-result-close" style="border:none; background:#eee; padding:4px 8px; border-radius:6px; cursor:pointer;">Close</button>
    </div>

    <hr style="margin:10px 0;" />

    <div style="font-size:13px; font-weight:700;">Recommendation</div>
    <div style="font-size:20px; font-weight:800; margin-bottom:10px;">${escapeHtml(result.recommendation || "Unknown")}</div>

    <div><b>Facebook ask:</b> ${result.facebookPrice ? "$" + result.facebookPrice : "Not detected"}</div>
<div><b>35% negotiated price:</b> ${result.negotiatedPrice35 ? "$" + result.negotiatedPrice35 : "N/A"}</div>
<div><b>Estimated resale value:</b> ${result.totalExpectedSalePrice != null ? "$" + result.totalExpectedSalePrice : "N/A"}</div>
<div><b>Profit at ask:</b> ${result.profitAtAsk != null ? "$" + result.profitAtAsk : "N/A"}</div>
<div><b>Profit at 35% off:</b> ${result.profitAt35 != null ? "$" + result.profitAt35 : "N/A"}</div>
<div><b>Max buy price:</b> ${result.maxBuyPrice != null ? "$" + result.maxBuyPrice : "N/A"}</div>

    <hr style="margin:10px 0;" />

    <div style="font-size:12px; font-weight:700;">Reason</div>
    <div style="font-size:12px; margin-bottom:10px;">${escapeHtml(result.reason || "")}</div>

    <hr style="margin:10px 0;" />

    <div style="font-size:12px; font-weight:700;">Primary items</div>
    ${itemRows || "<div>No item results.</div>"}

    ${ignoredRows ? `
      <hr style="margin:10px 0;" />
      <div style="font-size:12px; font-weight:700;">Ignored items</div>
      ${ignoredRows}
    ` : ""}
  `;

  document.body.appendChild(panel);

  document.getElementById("ebay-comp-result-close").onclick = () => {
    panel.remove();
  };
}

function showEbayCompLoading(message) {
  showEbayCompPanel({
    recommendation: "Analyzing...",
    targetProduct: message,
    validSoldCount: 0,
    reason: "Scraping visible eBay sold results and sending them to the local server."
  });
}

function waitForEbayListings(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();

    const interval = setInterval(() => {
      const pageText = document.body.innerText || "";
      const hasSoldText = pageText.includes("Sold ");
      const hasPrices = /\$[\d,]+(\.\d{2})?/.test(pageText);
      const hasItemLinks = document.querySelectorAll("a[href*='/itm/']").length > 0;

      if ((hasSoldText && hasPrices) || hasItemLinks) {
        clearInterval(interval);
        resolve(true);
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 500);
  });
}

function shouldAutoSaveDeal(result) {
  return isHitRecommendation(result);
}

async function saveDealToGoogleSheet(savedDeal) {
  try {
    const response = await fetchLocalServer("/save-deal-to-sheet", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        deal: savedDeal
      })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      console.warn("Google Sheets save failed:", data.error || "Unknown error");
      return false;
    }

    console.log(
  "Saved deal to Google Sheet:",
  savedDeal.facebookUrl
);

if (data.analysisLogUrl) {
  console.log(
    "Permanent analysis log:",
    data.analysisLogUrl
  );
}

await markMarketplaceAnalysisRunCompleted();

return true;
  } catch (error) {
    console.warn("Could not save deal to Google Sheet:", error.message);
    return false;
  }
}

async function saveDealToLibrary({ context, result }) {
  if (!shouldAutoSaveDeal(result)) {
    return;
  }

  const stored = await chrome.storage.local.get("savedDealLibrary");
  const existingLibrary = Array.isArray(stored.savedDealLibrary)
    ? stored.savedDealLibrary
    : [];

  const facebookUrl = context.facebookUrl || "";
  const savedAt = new Date().toISOString();

const primaryItemsWithStd = Array.isArray(result.items)
  ? result.items.filter(item =>
      item?.isPrimarySellableItem !== false &&
      item?.priceStandardDeviation != null
    )
  : [];

const topLevelPriceStandardDeviation =
  result.priceStandardDeviation ??
  (
    primaryItemsWithStd.length === 1
      ? primaryItemsWithStd[0].priceStandardDeviation
      : null
  );

const storedAnalysisRun =
  await chrome.storage.local.get(
    MARKETPLACE_ANALYSIS_RUN_KEY
  );

const analysisRunId =
  storedAnalysisRun[
    MARKETPLACE_ANALYSIS_RUN_KEY
  ]?.id || "";

const savedDeal = {
  id:
    `${Date.now()}_${Math.random().toString(36).slice(2)}`,

  savedAt,

  analysisRunId,

  recommendation:
    result.recommendation || "",

  title:
    context.originalFacebookTitle || "",

  facebookUrl,
  facebookPrice: result.facebookPrice ?? context.facebookPrice ?? null,
  negotiatedPrice35: result.negotiatedPrice35 ?? null,
  estimatedResaleValue: result.totalExpectedSalePrice ?? result.expectedSalePrice ?? null,
  priceStandardDeviation: topLevelPriceStandardDeviation,
  profitAtAsk: result.profitAtAsk ?? null,
  profitAt35: result.profitAt35 ?? null,
  maxBuyPrice: result.maxBuyPrice ?? null,
  reason: result.reason || "",
  items: result.items || [],
  ignoredItems: result.ignoredItems || context.ignoredItems || [],
  rawResult: result
};

const recommendation = String(result.recommendation || "").toLowerCase();

const isHit =
  recommendation.includes("buy") ||
  recommendation.includes("negotiate");

   const librarySavingEnabled =
    await isLibrarySavingEnabled();

  if (librarySavingEnabled) {
    // Prevent duplicate saves for the same Facebook URL.
    const withoutDuplicate = facebookUrl
      ? existingLibrary.filter(
          entry => entry.facebookUrl !== facebookUrl
        )
      : existingLibrary;

    const updatedLibrary = [
      savedDeal,
      ...withoutDuplicate
    ].slice(0, 250);

    await chrome.storage.local.set({
      savedDealLibrary: updatedLibrary
    });

    console.log(
      "Saved deal to library:",
      savedDeal
    );
  }

  // Always save hits to Google Sheets,
  // regardless of library setting.
  await saveDealToGoogleSheet(savedDeal);

  if (isHit) {
  const storedAuto = await chrome.storage.local.get(MARKETPLACE_AUTO_STATE_KEY);
  const state = storedAuto[MARKETPLACE_AUTO_STATE_KEY];

  if (state?.running) {
    const currentLog = state.sessionLog || {
      startedAt: Date.now(),
      clickedListings: 0,
      hitsFound: 0
    };

    await updateMarketplaceSessionLog({
      hitsFound: currentLog.hitsFound + 1
    });

    console.log("Session hit found from final result. Total hits:", currentLog.hitsFound + 1);
  }
}

}

async function markMarketplaceAutoAnalysisComplete(
  finalResult,
  options = {}
) {
  const stored = await chrome.storage.local.get(
    MARKETPLACE_AUTO_STATE_KEY
  );

  const state = stored[MARKETPLACE_AUTO_STATE_KEY];

  if (options.preserveMalformedJsonRetryCount !== true) {
    const facebookUrl =
  String(
    window.location.href ||
    ""
  ).split("?")[0];

    const listingId =
      getFacebookMarketplaceItemId(facebookUrl);

    if (listingId) {
      await clearMalformedJsonRetryCount(listingId);
    }
  }

if (!state?.running) return;

const completedFacebookUrl =
  String(
    window.location.href ||
    ""
  ).split("?")[0];

const completedListingId =
  getFacebookMarketplaceItemId(
    completedFacebookUrl
  );

if (completedListingId) {
  await clearListingAnalysisRetryCount(
    completedListingId
  );
}

await updateSessionListingResult(finalResult);

await upsertMarketplaceAnalysisJob({
  status:
    "complete",

  stage:
    "complete",

  finalResult,

  completedAt:
    Date.now()
});

/*
  If this listing owns the serialized finishing
  lock, its finishing work is now complete.
*/
await releaseMarketplaceFinishLock();


const latestStoredBeforeCompletionWrite =
  await chrome.storage.local.get(
    MARKETPLACE_AUTO_STATE_KEY
  );

const latestStateBeforeCompletionWrite =
  latestStoredBeforeCompletionWrite[
    MARKETPLACE_AUTO_STATE_KEY
  ] || state;


await chrome.storage.local.set({
  [MARKETPLACE_AUTO_STATE_KEY]: {
    ...latestStateBeforeCompletionWrite,

    lastResult:
      finalResult,

    lastResultAt:
      Date.now()
  }
});

  console.log("Marked Marketplace auto analysis complete:", finalResult?.recommendation);
}

async function isMarketplaceAutoAnalyzerRunning() {
  const stored = await chrome.storage.local.get(MARKETPLACE_AUTO_STATE_KEY);
  const state = stored[MARKETPLACE_AUTO_STATE_KEY];

  if (!state?.running) return false;

  if (state.stopAt && Date.now() >= state.stopAt) {
    console.log("Auto analyzer timer expired. Stopping scan.");

    await stopMarketplaceAutoAnalyzer({
      reason: "Timer expired"
    });

    return false;
  }

  return true;
}

function getSearchPollutionRerunGate(
  itemResult
) {
  const MINIMUM_VALID_COMPS = 7;
  const MINIMUM_RELATED_WRONG_MODEL_COMPS =
    8;

  const searchPollution =
    itemResult?.searchPollution || {};

  const validExactModelCount =
    Math.max(
      0,
      Number(
        searchPollution
          .validExactModelCount ??
        itemResult?.validExactModelCount ??
        itemResult?.validSoldCount ??
        0
      )
    );

  const relatedWrongModelCount =
    Math.max(
      0,
      Number(
        searchPollution
          .relatedWrongModelCount ??
        itemResult
          ?.relatedWrongModelCount ??
        0
      )
    );

  const belowMinimumCompThreshold =
    validExactModelCount <
    MINIMUM_VALID_COMPS;

  const enoughRelatedWrongModels =
    relatedWrongModelCount >=
    MINIMUM_RELATED_WRONG_MODEL_COMPS;

  /*
    The browser independently enforces the same
    rule as the server.

    A high number of removed listings alone does
    not trigger a rerun.
  */
  const allowed =
    belowMinimumCompThreshold &&
    enoughRelatedWrongModels &&
    searchPollution
      .pollutedByRelatedModels === true &&
    itemResult.rerunRecommended === true;

  return {
    allowed,

    validExactModelCount,
    relatedWrongModelCount,

    belowMinimumCompThreshold,
    enoughRelatedWrongModels,

    pollutedByRelatedModels:
      searchPollution
        .pollutedByRelatedModels === true,

    minimumValidComps:
      MINIMUM_VALID_COMPS,

    minimumRelatedWrongModelComps:
      MINIMUM_RELATED_WRONG_MODEL_COMPS
  };
}

async function runRemoteEbayCompWorkflow() {
  const stored =
    await chrome.storage.local.get(
      "ebayCompContext"
    );

  let context =
    stored.ebayCompContext;

  if (!context) {
    throw new Error(
      "Remote eBay workflow started without ebayCompContext."
    );
  }

  if (
    context.ebayExecutionMode !==
    "remote"
  ) {
    throw new Error(
      "Remote eBay workflow called for a locally-routed listing."
    );
  }

  const items =
    Array.isArray(
      context.items
    )
      ? context.items
      : [];

  console.log(
    "[REMOTE EBAY] Starting listing-level remote workflow:",
    {
      facebookUrl:
        context.facebookUrl,
      itemCount:
        items.length
    }
  );

  /*
    Process every eBay-compable product belonging
    to this Marketplace listing.
  */
  while (
    Number(
      context.currentItemIndex ||
      0
    ) <
    items.length
  ) {
    const currentItemIndex =
      Number(
        context.currentItemIndex ||
        0
      );

    let currentItem =
      context.items[
        currentItemIndex
      ];

    /*
      Same skip behavior as normal workflow.
    */
    if (
      !String(
        currentItem
          ?.ebaySearchQuery ||
        ""
      ).trim()
    ) {
      context = {
        ...context,

        results: [
          ...(context.results || []),

          {
            item:
              currentItem,

            result: {
              recommendation:
                "Skipped",

              validSoldCount:
                0,

              medianSoldPrice:
                null,

              expectedSalePrice:
                null,

              reason:
                "Skipped because this item did not have a resolved eBay search query."
            }
          }
        ],

        currentItemIndex:
          currentItemIndex + 1
      };

      await chrome.storage.local.set({
        ebayCompContext:
          context
      });

      continue;
    }

    /*
      ------------------------------------------------------------
      FIRST EBAY SEARCH
      ------------------------------------------------------------
    */

    const remoteSearch =
      await runSingleRemoteEbaySearch({
        item:
          currentItem,

        negativeSearchTerms:
          currentItem
            .negativeSearchTerms,

        context
      });

    console.log(
      "[REMOTE EBAY] Raw listings returned:",
      {
        jobId:
          remoteSearch.jobId,

        ebayUrl:
          remoteSearch.ebayUrl,

        count:
          remoteSearch
            .listings
            .length
      }
    );

    let evaluationResponse =
      await fetchLocalServer(
        "/evaluate-comps",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              target: {
                ...currentItem,

                facebookPrice:
                  context.facebookPrice,

                originalFacebookTitle:
                  context
                    .originalFacebookTitle,

                facebookDescription:
                  context
                    .facebookDescription,

                ebaySearchQuery:
                  currentItem
                    .ebaySearchQuery
              },

              listings:
                remoteSearch.listings
            })
        }
      );

    let itemResult =
      await readJsonSafely(
        evaluationResponse
      );

    if (
      !evaluationResponse.ok ||
      itemResult.error
    ) {
      throw new LocalServerError(
        itemResult,
        "Remote comp evaluation failed."
      );
    }

    /*
      ------------------------------------------------------------
      SEARCH-POLLUTION RERUN

      Preserve the same one-rerun maximum as your
      existing local eBay workflow.
      ------------------------------------------------------------
    */

    const rerunTerms =
      Array.isArray(
        itemResult
          .rerunNegativeSearchTerms
      )
        ? itemResult
            .rerunNegativeSearchTerms

        : Array.isArray(
            itemResult
              .searchPollution
              ?.negativeSearchTerms
          )
          ? itemResult
              .searchPollution
              .negativeSearchTerms

          : [];

    const pollutionGate =
      getSearchPollutionRerunGate(
        itemResult
      );

    const alreadyReran =
      currentItem
        .searchPollutionRerunDone ===
      true;

    if (
      pollutionGate.allowed &&
      rerunTerms.length > 0 &&
      !alreadyReran
    ) {
      console.log(
        "[REMOTE EBAY] Pollution rerun required:",
        {
          target:
            currentItem
              .ebaySearchQuery,

          rerunTerms
        }
      );

      currentItem = {
        ...currentItem,

        negativeSearchTerms: [
          ...(
            Array.isArray(
              currentItem
                .negativeSearchTerms
            )
              ? currentItem
                  .negativeSearchTerms
              : []
          ),

          ...rerunTerms
        ],

        searchPollutionRerunDone:
          true,

        searchPollutionRerunReason:
          itemResult.rerunReason ||
          "",

        searchPollutionFirstPass:
          itemResult
            .searchPollution ||
          null
      };

      context = {
        ...context,

        items:
          context.items.map(
            (item, index) =>
              index ===
              currentItemIndex
                ? currentItem
                : item
          )
      };

      await chrome.storage.local.set({
        ebayCompContext:
          context
      });

      /*
        IMPORTANT:

        This still goes through the SAME remote worker,
        because the entire Marketplace listing was assigned
        remote mode.
      */

      const rerunSearch =
        await runSingleRemoteEbaySearch({
          item:
            currentItem,

          negativeSearchTerms:
            currentItem
              .negativeSearchTerms,

          context
        });

      evaluationResponse =
        await fetchLocalServer(
          "/evaluate-comps",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                target: {
                  ...currentItem,

                  facebookPrice:
                    context
                      .facebookPrice,

                  originalFacebookTitle:
                    context
                      .originalFacebookTitle,

                  facebookDescription:
                    context
                      .facebookDescription,

                  ebaySearchQuery:
                    currentItem
                      .ebaySearchQuery
                },

                listings:
                  rerunSearch.listings
              })
          }
        );

      itemResult =
        await readJsonSafely(
          evaluationResponse
        );

      if (
        !evaluationResponse.ok ||
        itemResult.error
      ) {
        throw new LocalServerError(
          itemResult,
          "Remote pollution-rerun evaluation failed."
        );
      }
    }

    /*
      ------------------------------------------------------------
      ITEM COMPLETE
      ------------------------------------------------------------
    */

    context = {
      ...context,

      results: [
        ...(context.results || []),

        {
          item:
            currentItem,

          result:
            itemResult
        }
      ],

      currentItemIndex:
        currentItemIndex + 1
    };

    await chrome.storage.local.set({
      ebayCompContext:
        context
    });

    console.log(
      "[REMOTE EBAY] Item complete:",
      {
        item:
          currentItem
            .ebaySearchQuery,

        itemNumber:
          currentItemIndex + 1,

        totalItems:
          items.length
      }
    );
  }

  /*
    ============================================================
    ALL ITEMS COMPLETE
    ============================================================
  */

  console.log(
    "[REMOTE EBAY] Entire Marketplace listing finished. Evaluating lot."
  );

  const finalResponse =
    await fetchLocalServer(
      "/evaluate-lot",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            context
          })
      }
    );

  const finalResult =
    await readJsonSafely(
      finalResponse
    );

  if (
    !finalResponse.ok ||
    finalResult.error
  ) {
    throw new LocalServerError(
      finalResult,
      "Remote final lot evaluation failed."
    );
  }

  console.log(
    "[REMOTE EBAY] Final lot evaluation:",
    finalResult
  );

  if (
    String(
      finalResult
        .recommendation ||
      ""
    )
      .trim()
      .toLowerCase() ===
    "scam"
  ) {
    await saveScamListing({
      context,
      result:
        finalResult
    });
  }

  await saveDealToLibrary({
    context,
    result:
      finalResult
  });

  if (
    !isHitRecommendation(
      finalResult
    )
  ) {
    await markMarketplaceAnalysisRunCompleted();
  }

  await markMarketplaceAutoAnalysisComplete(
    finalResult
  );

  showLotCompPanel(
    finalResult
  );

  return finalResult;
}

async function runEbayCompAnalyzer() {
  const stored = await chrome.storage.local.get("ebayCompContext");
  const context = stored.ebayCompContext;

  if (!context) {
    console.log("No eBay comp context found.");
    return;
  }

  const ageMinutes = (Date.now() - context.createdAt) / 60000;

  if (ageMinutes > 30) {
    console.log("eBay comp context is stale.");
    return;
  }

  const items = context.items || [];

  if (!items.length) {
    console.log("No items found in comp context.");
    return;
  }

  const currentItemIndex = context.currentItemIndex || 0;
  const currentItem = items[currentItemIndex];

  if (!currentItem) {
    console.log("No current item found.");
    return;
  }

  showEbayCompLoading(
    context.mode === "bundle"
      ? `Bundle item ${currentItemIndex + 1} of ${items.length}: ${currentItem.ebaySearchQuery}`
      : currentItem.ebaySearchQuery
  );

  try {
    const foundListings = await waitForEbayListings(10000);

    console.log("eBay listings found:", foundListings);
    console.log("Raw li.s-item count:", document.querySelectorAll("li.s-item").length);

    const listings = extractEbaySoldListings();

    console.log("Extracted eBay listings:", listings);
    console.table(listings.map(item => ({
      title: item.title,
      price: item.price,
      condition: item.condition,
      soldDate: item.soldDate
    })));

  const response = await fetchLocalServer("/evaluate-comps", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    target: {
      ...currentItem,
      facebookPrice: context.facebookPrice,
      originalFacebookTitle: context.originalFacebookTitle,
      facebookDescription: context.facebookDescription,
      ebaySearchQuery: currentItem.ebaySearchQuery
    },
    listings
  })
});

const itemResult = await readJsonSafely(response);

if (!response.ok || itemResult.error) {
  throw new LocalServerError(
    itemResult,
    "Comp evaluation failed."
  );
}
    console.log("Comp evaluation result for current item:", itemResult);
    
const rerunTerms =
  Array.isArray(
    itemResult.rerunNegativeSearchTerms
  )
    ? itemResult.rerunNegativeSearchTerms
    : Array.isArray(
        itemResult.searchPollution
          ?.negativeSearchTerms
      )
      ? itemResult.searchPollution
          .negativeSearchTerms
      : [];

const alreadyReranForPollution =
  currentItem.searchPollutionRerunDone === true;

const pollutionGate = getSearchPollutionRerunGate(itemResult);

if (
  pollutionGate.allowed &&
  rerunTerms.length > 0 &&
  !alreadyReranForPollution
) {
  const updatedItems = items.map((item, index) => {
    if (index !== currentItemIndex) return item;

    return {
      ...item,
      negativeSearchTerms: [
        ...(Array.isArray(item.negativeSearchTerms) ? item.negativeSearchTerms : []),
        ...rerunTerms
      ],
      searchPollutionRerunDone: true,
      searchPollutionRerunReason: itemResult.rerunReason || "",
      searchPollutionFirstPass: itemResult.searchPollution || null
    };
  });

  await chrome.storage.local.set({
    ebayCompContext: {
      ...context,
      items: updatedItems,
      currentItemIndex
    }
  });

  console.log("Rerunning eBay search due to related-model pollution:", {
    target: currentItem.ebaySearchQuery,
    rerunTerms,
    reason: itemResult.rerunReason
  });

  showEbayCompPanel({
    recommendation: "Rerunning search",
    targetProduct: `${currentItem.brand || ""} ${currentItem.model || ""} ${currentItem.productType || ""}`.trim(),
    condition: currentItem.condition,
    validSoldCount: itemResult.validSoldCount || 0,
    medianEligibleCount: itemResult.medianEligibleCount ?? null,
    medianSoldPrice: itemResult.medianSoldPrice || null,
    expectedSalePrice: itemResult.expectedSalePrice || null,
    reason: `Search was polluted by related models. Rerunning with exclusions: ${rerunTerms.join(", ")}`,
    validComps: itemResult.validComps || [],
    debugCounts: itemResult.debugCounts
  });

 setTimeout(
  async () => {
    const opened =
      openEbaySoldSearch(
        currentItem.ebaySearchQuery,
        currentItem.condition,
        rerunTerms
      );

    if (!opened) {
      const unresolvedResult = {
        recommendation:
          "Unresolved",

        reason:
          "Search-pollution rerun was skipped because the item had no resolved eBay query.",

        item:
          currentItem
      };

      await markMarketplaceAutoAnalysisComplete(
        unresolvedResult
      );

      return;
    }
  },
  1200
);

return;
}

const updatedResults = [
      ...(context.results || []),
      {
        item: currentItem,
        result: itemResult
      }
    ];

    const updatedContext = {
      ...context,
      results: updatedResults,
      currentItemIndex: currentItemIndex + 1
    };

    let nextIndex = currentItemIndex + 1;
const skippedResults = [];

while (nextIndex < items.length && !String(items[nextIndex].ebaySearchQuery || "").trim()) {
  const skippedItem = items[nextIndex];

  skippedResults.push({
    item: skippedItem,
    result: {
      recommendation: "Skipped",
      validSoldCount: 0,
      medianSoldPrice: null,
      expectedSalePrice: null,
      reason: "Skipped because this item did not have a resolved eBay search query."
    }
  });

  nextIndex += 1;
}

const contextAfterSkips = {
  ...updatedContext,
  results: [
    ...(updatedContext.results || []),
    ...skippedResults
  ],
  currentItemIndex: nextIndex
};

const hasNextItem =
  nextIndex < items.length;

if (hasNextItem) {
  /*
    Saving is required here because the NEXT eBay tab
    has to resume from this context.
  */
  await chrome.storage.local.set({
    ebayCompContext:
      contextAfterSkips
  });
  const nextItem = items[nextIndex];

  showEbayCompPanel({
    recommendation: "Analyzing bundle...",
    targetProduct: `Completed item ${currentItemIndex + 1} of ${items.length}. Opening next item: ${nextItem.ebaySearchQuery}`,
    condition: currentItem.condition,
    validSoldCount: itemResult.validSoldCount || 0,
    medianEligibleCount: itemResult.medianEligibleCount ?? null,
    medianSoldPrice: itemResult.medianSoldPrice || null,
    expectedSalePrice: itemResult.expectedSalePrice || null,
    lowPrice: itemResult.lowPrice || null,
    highPrice: itemResult.highPrice || null,
    bestOfferExcludedCount: itemResult.bestOfferExcludedCount || 0,
    removedByAiFilter: itemResult.removedByAiFilter ?? null,
    reason: skippedResults.length
      ? `Finished this item. Skipped ${skippedResults.length} unresolved item(s). Opening the next searchable bundle item.`
      : "Finished this item. Opening the next bundle item.",
    validComps: itemResult.validComps || [],
    debugCounts: itemResult.debugCounts
  });

setTimeout(async () => {
  openEbaySoldSearch(
  nextItem.ebaySearchQuery,
  nextItem.condition,
  nextItem.negativeSearchTerms
);

  const autoRunning = await isMarketplaceAutoAnalyzerRunning();

  if (autoRunning) {
    setTimeout(() => {
      window.close();
    }, 800);
  }
}, 1200);

return;
}

console.log(
  "[EBAY FLOW] All eBay items complete. Starting final lot evaluation.",
  {
    resultCount:
      contextAfterSkips
        .results
        ?.length || 0,

    facebookPrice:
      contextAfterSkips
        .facebookPrice
  }
);

    // No more items. Evaluate the whole bundle or single item.
 const finalResponse = await fetchLocalServer("/evaluate-lot", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    context: contextAfterSkips
  })
});

const finalResult = await readJsonSafely(finalResponse);

if (!finalResponse.ok || finalResult.error) {
  throw new LocalServerError(
    finalResult,
    "Final lot evaluation failed."
  );
}

console.log("Final lot evaluation:", finalResult);

if (
  String(
    finalResult.recommendation || ""
  )
    .trim()
    .toLowerCase() === "scam"
) {
  await saveScamListing({
    context: contextAfterSkips,
    result: finalResult
  });
}

await saveDealToLibrary({
  context: contextAfterSkips,
  result: finalResult
});

/*
  Hits already mark themselves completed after
  successful Supabase + Sheets saving.

  Pass/Scam/etc. also need to close their run so
  a later manual scan of the same listing gets
  a fresh log.
*/
if (
  !isHitRecommendation(
    finalResult
  )
) {
  await markMarketplaceAnalysisRunCompleted();
}

await markMarketplaceAutoAnalysisComplete(
  finalResult
);

showLotCompPanel(
  finalResult
);

const autoRunning = await isMarketplaceAutoAnalyzerRunning();

if (autoRunning) {
  setTimeout(() => {
    window.close();
  }, 1200);
}
} catch (error) {
  console.error(error);

  const shouldRestartForJson =
    error?.retryEntireListing === true ||
    error?.code === "MALFORMED_AI_JSON" ||
    error?.code === "MALFORMED_SERVER_JSON";

  if (shouldRestartForJson) {
    await restartEntireFacebookListingScanBecauseMalformedJson({
      step: error.step || "eBay analysis",
      errorMessage: error.message || ""
    });

    return;
  }

  await markMarketplaceAutoAnalysisComplete({
    recommendation: "Error",
    reason:
      error.message ||
      "eBay analysis failed."
  });

  showEbayCompPanel({
    recommendation: "Error",
    reason:
      error.message ||
      "eBay analysis failed.",
    validSoldCount: 0,
    medianSoldPrice: null,
    validComps: []
  });

  const autoRunning =
    await isMarketplaceAutoAnalyzerRunning();

  if (autoRunning) {
    setTimeout(() => {
      window.close();
    }, 1200);
  }
}

/*
  Close runEbayCompAnalyzer()
*/
}

function addAutoAnalyzerButtons() {
  const existingStandardButton =
    document.getElementById(
      "marketplace-auto-analyzer-start-btn"
    );

  const existingRandomButton =
    document.getElementById(
      "marketplace-random-keyword-scan-btn"
    );

  const existingStopButton =
    document.getElementById(
      "marketplace-auto-analyzer-stop-btn"
    );

if (
  existingRandomButton &&
  existingStopButton
) {
  return;
}

  if (!existingRandomButton) {
    const randomKeywordButton =
      document.createElement("button");

    randomKeywordButton.id =
      "marketplace-random-keyword-scan-btn";

    randomKeywordButton.innerText =
      "Random Keyword Scan";

    randomKeywordButton.title =
      "Run the normal auto scanner and switch to a random Marketplace keyword after 30 seconds without a fresh listing.";

    randomKeywordButton.onclick =
      async () => {
        const input = prompt(
          "How many minutes should Random Keyword Scan run?\n\nLeave blank for no timer.",
          "60"
        );

        if (input === null) return;

        const trimmed =
          input.trim();

        if (!trimmed) {
          await startMarketplaceAutoAnalyzer(
            null,
            {
              scanMode:
                MARKETPLACE_RANDOM_KEYWORD_MODE
            }
          );

          return;
        }

        const minutes =
          Number(trimmed);

        if (
          !Number.isFinite(minutes) ||
          minutes <= 0
        ) {
          alert(
            "Please enter a valid number of minutes."
          );

          return;
        }

        await startMarketplaceAutoAnalyzer(
          minutes,
          {
            scanMode:
              MARKETPLACE_RANDOM_KEYWORD_MODE
          }
        );
      };

    document.body.appendChild(
      randomKeywordButton
    );
  }

  if (!existingStopButton) {
    const stopButton =
      document.createElement("button");

    stopButton.id =
      "marketplace-auto-analyzer-stop-btn";

    stopButton.innerText =
      "Stop Scan";

    stopButton.onclick =
      stopMarketplaceAutoAnalyzer;

    document.body.appendChild(
      stopButton
    );
  }
}

function addButton() {
  if (document.getElementById("ebay-comp-checker-btn")) return;

  const button = document.createElement("button");
  button.id = "ebay-comp-checker-btn";
  button.innerText = "AI Check eBay Sold";
button.onclick =
  async () => {
    try {
      await aiCheckListing();

    } catch (error) {
      console.error(
        "[PIPELINE JOB] Unhandled listing-analysis failure:",
        error
      );

      try {
        await upsertMarketplaceAnalysisJob({
          status:
            "failed",

          stage:
            "unhandled-error",

          failureReason:
            error?.message ||
            String(error),

          failedAt:
            Date.now()
        });

        await releaseMarketplaceFinishLock();

      } catch (cleanupError) {
        console.error(
          "[PIPELINE JOB] Could not record failed job:",
          cleanupError
        );
      }
    }
  };

  document.body.appendChild(button);
}

async function addLibrarySavingToggleButton() {
  if (
    document.getElementById(
      "library-saving-toggle-btn"
    )
  ) {
    return;
  }

  const button =
    document.createElement("button");

  button.id =
    "library-saving-toggle-btn";

 async function refreshButton() {
  const enabled =
    await isLibrarySavingEnabled();

  button.innerText =
    enabled
      ? "Library Saving: ON"
      : "Library Saving: OFF";

  button.dataset.enabled =
    enabled ? "true" : "false";

  button.title =
    enabled
      ? "Listings are currently being saved to the local libraries."
      : "Local library saving is disabled. Scanner state and statistics are still saved.";

  const sessionListingsButton =
    document.getElementById(
      "session-listings-btn"
    );

  const scamListingsButton =
    document.getElementById(
      "scam-listings-btn"
    );

  const savedDealsButton =
    document.getElementById(
      "saved-deals-btn"
    );

  if (sessionListingsButton) {
    sessionListingsButton.style.display =
      enabled ? "" : "none";
  }

  if (scamListingsButton) {
    scamListingsButton.style.display =
      enabled ? "" : "none";
  }

  if (savedDealsButton) {
    savedDealsButton.style.display =
      enabled ? "" : "none";
  }
}

  button.onclick = async () => {
    const currentlyEnabled =
      await isLibrarySavingEnabled();

    await setLibrarySavingEnabled(
      !currentlyEnabled
    );

    await refreshButton();
  };

  await refreshButton();

  document.body.appendChild(button);
}

async function addSessionListingsButton() {
  if (document.getElementById("session-listings-btn")) return;

  const button = document.createElement("button");
  button.id = "session-listings-btn";
  button.innerText = "Session Listings";
  button.title = "View every Marketplace listing clicked during Auto Scan";
  button.onclick = showSessionListingsLibrary;

  const enabled =
  await isLibrarySavingEnabled();

button.style.display =
  enabled ? "" : "none";

  document.body.appendChild(button);
}

async function addSavedDealsButton() {
  if (document.getElementById("saved-deals-btn")) return;

  const button = document.createElement("button");
  button.id = "saved-deals-btn";
  button.innerText = "Saved Deals";
  button.onclick = showSavedDealLibrary;

  const enabled =
    await isLibrarySavingEnabled();

  button.style.display =
    enabled ? "" : "none";

  document.body.appendChild(button);
}

async function addScamListingsButton() {
  if (
    document.getElementById(
      "scam-listings-btn"
    )
  ) {
    return;
  }

  const button =
    document.createElement("button");

  button.id = "scam-listings-btn";
  button.innerText = "Scam Listings";
  button.title =
    "View listings that exceeded the 2.5x resale-to-ask threshold";

  button.onclick =
    showScamListingsLibrary;

  document.body.appendChild(button);
}

/*
  ============================================================
  FACEBOOK MARKETPLACE / MESSENGER CONVERSATION TRACKER
  ============================================================
*/

const MARKETPLACE_TRACKER_ACCOUNT_KEY =
  "marketplaceConversationTrackerAccountId";

const MARKETPLACE_TRACKER_FINGERPRINT_KEY =
  "marketplaceConversationTrackerFingerprints";


function getMessengerConversationIdFromUrl(
  value
) {
  const text =
    String(
      value || ""
    );

  const match =
    text.match(
      /\/messages\/t\/(\d+)/
    );

  return match?.[1] || "";
}


function getCurrentMessengerConversationId() {
  return getMessengerConversationIdFromUrl(
    window.location.href
  );
}


function getMarketplaceListingFromCurrentMessengerThread() {
  const links =
    Array.from(
      document.querySelectorAll(
        'a[href*="/marketplace/item/"]'
      )
    );

  for (const link of links) {
    const href =
      String(
        link.href || ""
      );

    const match =
      href.match(
        /\/marketplace\/item\/(\d+)/
      );

    if (!match) {
      continue;
    }

    const listingId =
      match[1];

    return {
      listingId,

      listingUrl:
        `https://www.facebook.com/marketplace/item/${listingId}/`
    };
  }

  return {
    listingId: "",
    listingUrl: ""
  };
}


/*
  Each Chrome profile receives its own tracker ID.

  This lets different Facebook/Chrome profiles feed
  conversations into the same Supabase database without
  being treated as the exact same account source.
*/
async function getMarketplaceTrackerAccountId() {
  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_TRACKER_ACCOUNT_KEY
    );

  const existing =
    String(
      stored[
        MARKETPLACE_TRACKER_ACCOUNT_KEY
      ] || ""
    ).trim();

  if (existing) {
    return existing;
  }


  const randomPart =
    typeof crypto?.randomUUID ===
      "function"
      ? crypto.randomUUID()
      : (
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2)
        );


  const accountId =
    `facebook_${randomPart}`;


  await chrome.storage.local.set({
    [MARKETPLACE_TRACKER_ACCOUNT_KEY]:
      accountId
  });


  return accountId;
}


/*
  Convert Facebook timestamps such as:

      11 minutes ago
      5 hours ago
      2 days ago
      yesterday

  into an ISO timestamp.
*/
function parseFacebookRelativeTimestamp(
  label
) {
  const text =
    String(label || "")
      .trim()
      .toLowerCase();

  if (!text) {
    return null;
  }

  const now =
    Date.now();


  if (
    text === "now" ||
    text === "just now"
  ) {
    return new Date(
      now
    ).toISOString();
  }


  if (
    text === "yesterday" ||
    text === "a day ago" ||
    text === "1 day ago"
  ) {
    return new Date(
      now -
      24 *
      60 *
      60 *
      1000
    ).toISOString();
  }


  /*
    Facebook can use:

    a minute ago
    an hour ago
    a day ago
    a week ago
  */
  const singularMatch =
    text.match(
      /^(?:a|an)\s+(minute|hour|day|week)\s+ago$/
    );

  if (singularMatch) {
    const unit =
      singularMatch[1];

    const multipliers = {
      minute:
        60 * 1000,

      hour:
        60 *
        60 *
        1000,

      day:
        24 *
        60 *
        60 *
        1000,

      week:
        7 *
        24 *
        60 *
        60 *
        1000
    };

    const multiplier =
      multipliers[unit];

    if (multiplier) {
      return new Date(
        now - multiplier
      ).toISOString();
    }
  }


  /*
    Numeric forms:

    11 minutes ago
    5 hours ago
    2 days ago
    3 weeks ago
  */
  const numericMatch =
    text.match(
      /^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\s+ago$/
    );

  if (!numericMatch) {
    return null;
  }


  const amount =
    Number(
      numericMatch[1]
    );

  const unit =
    numericMatch[2];


  const multipliers = {
    minute:
      60 * 1000,

    minutes:
      60 * 1000,

    hour:
      60 *
      60 *
      1000,

    hours:
      60 *
      60 *
      1000,

    day:
      24 *
      60 *
      60 *
      1000,

    days:
      24 *
      60 *
      60 *
      1000,

    week:
      7 *
      24 *
      60 *
      60 *
      1000,

    weeks:
      7 *
      24 *
      60 *
      60 *
      1000
  };


  const multiplier =
    multipliers[unit];

  if (
    !Number.isFinite(amount) ||
    !multiplier
  ) {
    return null;
  }


  return new Date(
    now -
    amount *
    multiplier
  ).toISOString();
}

function getMarketplaceConversationRow(
  anchor
) {
  if (!anchor) {
    return null;
  }


  let element =
    anchor;


  /*
    Walk upward through Facebook's wrappers.

    We want the smallest ancestor that contains:
    - the Messenger thread link
    - a timestamp
  */
  for (
    let depth = 0;
    depth < 10 &&
    element;
    depth++
  ) {
    const hasConversationLink =
      element.querySelector?.(
        'a[href*="/messages/t/"]'
      );

    const hasTimestamp =
      element.querySelector?.(
        "abbr[aria-label]"
      );


    if (
      hasConversationLink &&
      hasTimestamp
    ) {
      return element;
    }


    element =
      element.parentElement;
  }


  /*
    Fall back to the anchor itself.
  */
  return anchor;
}

/*
  Parse:

      Faith · Canon eos 630 film camera...

  into:

      sellerName = Faith
      listingTitle = Canon eos 630...
*/
function parseMarketplaceConversationTitle(
  lines
) {
  const candidates =
    Array.isArray(lines)
      ? lines
      : [];


  for (const line of candidates) {
    const text =
      String(
        line || ""
      ).trim();

    if (
      !text ||
      !text.includes(" · ")
    ) {
      continue;
    }


    if (
      text
        .toLowerCase()
        .includes(
          "waiting for your response"
        )
    ) {
      continue;
    }


    const separatorIndex =
      text.indexOf(
        " · "
      );


    if (
      separatorIndex <= 0
    ) {
      continue;
    }


    const sellerName =
      text
        .slice(
          0,
          separatorIndex
        )
        .trim();


    const listingTitle =
      text
        .slice(
          separatorIndex + 3
        )
        .trim();


    if (
      sellerName &&
      listingTitle
    ) {
      return {
        sellerName,
        listingTitle,
        fullTitle:
          text
      };
    }
  }


  return {
    sellerName: "",
    listingTitle: "",
    fullTitle: ""
  };
}


/*
  Determine who sent the latest message from Facebook's
  sidebar preview.

  Examples:

      Faith is waiting for your response about...
          -> seller

      Faith: Yeah I'm okay shipping...
          -> seller

      You: Sounds good...
          -> me
*/
function determineMarketplaceLastMessage({
  lines,
  sellerName
}) {
  const cleanLines =
    (Array.isArray(lines)
      ? lines
      : []
    )
      .map(
        line =>
          String(
            line || ""
          ).trim()
      )
      .filter(Boolean);


  /*
    Facebook's strongest explicit signal.
  */
  const waitingLine =
    cleanLines.find(
      line =>
        line
          .toLowerCase()
          .includes(
            " is waiting for your response about "
          )
    );


  if (waitingLine) {
    return {
      sender:
        "seller",

      text:
        waitingLine
    };
  }


  const myLine =
    cleanLines.find(
      line =>
        /^you\s*:/i.test(
          line
        )
    );


  if (myLine) {
    return {
      sender:
        "me",

      text:
        myLine
          .replace(
            /^you\s*:\s*/i,
            ""
          )
          .trim()
    };
  }


  if (sellerName) {
    const escapedName =
      String(
        sellerName
      )
        .replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );


    const sellerRegex =
      new RegExp(
        `^${escapedName}\\s*:`,
        "i"
      );


    const sellerLine =
      cleanLines.find(
        line =>
          sellerRegex.test(
            line
          )
      );


    if (sellerLine) {
      return {
        sender:
          "seller",

        text:
          sellerLine
            .replace(
              sellerRegex,
              ""
            )
            .trim()
      };
    }
  }


  return {
    sender:
      "unknown",

    text:
      ""
  };
}


/*
  Read the Marketplace/Messenger conversation list.

  Facebook can render more than one anchor for the same
  thread, so conversations are deduplicated by thread ID.
*/
function scrapeVisibleMarketplaceConversations() {
  const anchors =
    Array.from(
      document.querySelectorAll(
        'a[href*="/messages/t/"]'
      )
    );


  const conversations =
    new Map();


  const currentConversationId =
    getCurrentMessengerConversationId();


  const currentListing =
    getMarketplaceListingFromCurrentMessengerThread();


  for (const anchor of anchors) {
    const conversationId =
      getMessengerConversationIdFromUrl(
        anchor.href
      );


    if (!conversationId) {
      continue;
    }


    if (
      conversations.has(
        conversationId
      )
    ) {
      continue;
    }


   const row =
  getMarketplaceConversationRow(
    anchor
  );


const rowText =
  String(
    row?.innerText ||
    row?.textContent ||
    anchor.innerText ||
    anchor.textContent ||
    ""
  ).trim();


    if (!rowText) {
      continue;
    }


    const lines =
      rowText
        .split(/\n+/)
        .map(
          line =>
            line.trim()
        )
        .filter(Boolean);


    const title =
      parseMarketplaceConversationTitle(
        lines
      );


    /*
      Ignore anchors that don't look like
      Marketplace seller conversations.
    */
    if (
      !title.sellerName ||
      !title.listingTitle
    ) {
      continue;
    }


    const lastMessage =
      determineMarketplaceLastMessage({
        lines,
        sellerName:
          title.sellerName
      });


const timeElement =
  row?.querySelector(
    "abbr[aria-label]"
  ) ||
  anchor.querySelector(
    "abbr[aria-label]"
  );


    const timeLabel =
      String(
        timeElement
          ?.getAttribute(
            "aria-label"
          ) || ""
      ).trim();


    const lastMessageAt =
      parseFacebookRelativeTimestamp(
        timeLabel
      );


    const unread =
      rowText
        .toLowerCase()
        .includes(
          "unread message:"
        );


    /*
      We only know the Marketplace listing ID from
      the currently opened Messenger thread.

      Once the server learns this mapping it keeps it.
    */
    const isCurrentConversation =
      currentConversationId &&
      currentConversationId ===
        conversationId;


    const listingId =
      isCurrentConversation
        ? currentListing.listingId
        : "";


    const listingUrl =
      isCurrentConversation
        ? currentListing.listingUrl
        : "";


    conversations.set(
      conversationId,
      {
        conversationId,

        conversationUrl:
          `https://www.facebook.com/messages/t/${conversationId}`,

        listingId,
        listingUrl,

        sellerName:
          title.sellerName,

        listingTitle:
          title.listingTitle,

        lastMessageText:
          lastMessage.text,

        lastMessageSender:
          lastMessage.sender,

        lastMessageAt,

        unread,

        timeLabel
      }
    );
  }


  return [
    ...conversations.values()
  ];
}


async function parseCurrentMarketplaceConversationForSession() {
  const conversationId =
    getCurrentMessengerConversationId();


  if (!conversationId) {
    return {
      ok: false,
      reason:
        "Current page is not a Messenger conversation."
    };
  }


  const listing =
    getMarketplaceListingFromCurrentMessengerThread();


  if (!listing.listingId) {
    return {
      ok: false,

      conversationId,

      reason:
        "Could not find Marketplace listing ID in Messenger thread."
    };
  }


  /*
    Give Messenger a moment to finish rendering
    the actual conversation body.
  */
  await sleep(
    1000
  );


  const threadTimestamp =
    getLatestMessengerThreadTimestamp();


  /*
    Find message-like presentation elements.

    Facebook currently renders message bubbles inside
    role="presentation" wrappers.
  */
  const candidates =
    Array.from(
      document.querySelectorAll(
        '[role="presentation"]'
      )
    )
      .map(
        element => {
          const text =
            String(
              element.innerText ||
              element.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim();

          const rect =
            element.getBoundingClientRect();

          return {
            element,
            text,
            rect
          };
        }
      )
      .filter(
        entry =>
          entry.text &&
          entry.text.length <=
            3000 &&
          entry.rect.width > 0 &&
          entry.rect.height > 0
      );


  /*
    Prefer leaf-ish elements so a giant Messenger
    container isn't mistaken for one message.
  */
  const messageCandidates =
    candidates.filter(
      entry => {
        const childPresentations =
          entry.element.querySelectorAll(
            '[role="presentation"]'
          );

        return (
          childPresentations.length <=
          2
        );
      }
    );


  if (
    !messageCandidates.length
  ) {
    return {
      ok: false,

      conversationId,

      listingId:
        listing.listingId,

      reason:
        "Could not find rendered Messenger messages."
    };
  }


  /*
    DOM order normally follows message order,
    so use the final rendered message candidate.
  */
  const latest =
    messageCandidates[
      messageCandidates.length -
      1
    ];


  /*
    Own messages are rendered on the right side,
    seller messages on the left.

    Compare the message center against the viewport.
  */
  const messageCenter =
    latest.rect.left +
    latest.rect.width / 2;


  const lastMessageSender =
    messageCenter >
      window.innerWidth *
      0.55
      ? "me"
      : "seller";


  const conversation = {
    conversationId,

    conversationUrl:
      `https://www.facebook.com/messages/t/${conversationId}`,

    listingId:
      listing.listingId,

    listingUrl:
      listing.listingUrl,

    sellerName:
      "",

    lastMessageText:
      latest.text,

    lastMessageSender,

    lastMessageAt:
      threadTimestamp.iso,

    unread:
      false,

    timeLabel:
      threadTimestamp.text
  };


  console.log(
    "[CONVERSATION PARSER] Direct thread parsed:",
    conversation
  );


  const result =
    await sendMarketplaceConversationToServer(
      conversation
    );


  return {
    ok: true,

    conversationId,

    listingId:
      listing.listingId,

    lastMessageSender,

    lastMessageAt:
      threadTimestamp.iso,

    lastMessageText:
      latest.text,

    tracked:
      result?.tracked ===
      true,

    status:
      result
        ?.conversation
        ?.status ||
      ""
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
      "PARSE_MARKETPLACE_CONVERSATION_NOW"
    ) {
      return;
    }

    (
      async () => {
        try {
          const result =
            await parseCurrentMarketplaceConversationForSession();

          sendResponse(
            result
          );

        } catch (error) {
          console.error(
            "[CONVERSATION PARSER] Current-thread parse failed:",
            error
          );

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

/*
  Avoid POSTing unchanged conversations every 15 seconds.
*/
function buildMarketplaceConversationFingerprint(
  conversation
) {
  return JSON.stringify({
    conversationId:
      conversation.conversationId,

    listingId:
      conversation.listingId,

    sellerName:
      conversation.sellerName,

    lastMessageText:
      conversation.lastMessageText,

    lastMessageSender:
      conversation.lastMessageSender,

    /*
      Do NOT use lastMessageAt here.

      It is recalculated from Date.now() every scan,
      which would make an unchanged message look new.
    */
    timeLabel:
      conversation.timeLabel,

    unread:
      conversation.unread
  });
}


async function sendMarketplaceConversationToServer(
  conversation
) {
  const accountId =
    await getMarketplaceTrackerAccountId();


  const response =
    await fetch(
      `${LOCAL_SERVER_BASE_URL}/marketplace-conversation`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            conversation: {
              ...conversation,
              accountId
            }
          })
      }
    );


  const text =
    await response.text();


  let data;

  try {
    data =
      JSON.parse(
        text
      );
  } catch (error) {
    throw new Error(
      `Conversation tracker server returned invalid JSON: ${text.slice(0, 500)}`
    );
  }


  if (
    !response.ok ||
    data?.ok !== true
  ) {
    throw new Error(
      data?.error ||
      `Conversation tracker failed with HTTP ${response.status}.`
    );
  }


  return data;
}


async function syncMarketplaceConversations() {
  /*
    Only run the inbox tracker on Facebook.
  */
  if (
    !window.location.hostname
      .includes(
        "facebook.com"
      )
  ) {
    return;
  }


  /*
    We need Messenger conversation links to actually
    exist on the current Facebook page.
  */
  if (
    !document.querySelector(
      'a[href*="/messages/t/"]'
    )
  ) {
    return;
  }


  const conversations =
    scrapeVisibleMarketplaceConversations();

    const mappedConversationIds =
  await getMappedMarketplaceConversationIds();


  if (!conversations.length) {
    return;
  }


  const stored =
    await chrome.storage.local.get(
      MARKETPLACE_TRACKER_FINGERPRINT_KEY
    );


  const fingerprints = {
    ...(
      stored[
        MARKETPLACE_TRACKER_FINGERPRINT_KEY
      ] || {}
    )
  };


  let changed =
    false;


  for (
    const conversation of
      conversations
  ) {

    /*
  If the currently opened thread reveals a
  Marketplace listing ID, permanently remember
  the Messenger -> Marketplace mapping locally.
*/
if (
  conversation.listingId
) {
  await rememberMappedMarketplaceConversation(
    conversation.conversationId
  );

  mappedConversationIds.add(
    conversation.conversationId
  );
}


/*
  Ignore random historical Messenger conversations
  that have never been mapped to one of our
  Marketplace listings.

  This prevents the tracker from POSTing the
  entire inbox every scan.
*/
if (
  !mappedConversationIds.has(
    conversation.conversationId
  )
) {
  continue;
}
    const conversationId =
      conversation
        .conversationId;


    const fingerprint =
      buildMarketplaceConversationFingerprint(
        conversation
      );


    if (
      fingerprints[
        conversationId
      ] === fingerprint
    ) {
      continue;
    }


    try {
const result =
  await sendMarketplaceConversationToServer(
    conversation
  );


/*
  ONLY cache the fingerprint when this
  conversation is actually eligible.

  This is important.

  If J is currently blank/N, we keep checking it.

  Therefore if you later change J to P,
  the tracker can begin tracking it without
  requiring another Messenger message.
*/
/*
  Cache the Messenger state regardless of whether
  the spreadsheet currently says P or N.

  Otherwise an N conversation would be POSTed
  again every 15 seconds forever.
*/
fingerprints[
  conversationId
] =
  fingerprint;

changed =
  true;


if (
  result?.tracked === true
) {
  console.log(
    "[CONVERSATION TRACKER] Active P conversation synced:",
    conversation
  );

} else {
  console.log(
    "[CONVERSATION TRACKER] Ignored by spreadsheet:",
    {
      conversationId,

      listingId:
        conversation.listingId,

      reason:
        result?.reason ||
        "Sheet J is not P."
    }
  );
}

    } catch (error) {
      console.warn(
        "[CONVERSATION TRACKER] Sync failed:",
        {
          conversationId,
          error:
            error?.message ||
            error
        }
      );
    }
  }


  if (changed) {
    await chrome.storage.local.set({
      [MARKETPLACE_TRACKER_FINGERPRINT_KEY]:
        fingerprints
    });
  }
}


function startMarketplaceConversationTracker() {
  if (
    window
      .__marketplaceConversationTrackerStarted
  ) {
    return;
  }


  window
    .__marketplaceConversationTrackerStarted =
      true;


  console.log(
    "[CONVERSATION TRACKER] Started."
  );


  /*
    Initial scan shortly after the Facebook page
    finishes rendering.
  */
  setTimeout(
    () => {
      syncMarketplaceConversations()
        .catch(
          error => {
            console.warn(
              "[CONVERSATION TRACKER] Initial sync failed:",
              error
            );
          }
        );
    },
    2500
  );


  /*
    Facebook is a SPA, so the content script normally
    survives navigation between inbox threads.

    Re-scan periodically rather than relying on a
    traditional page-load event.
  */
 /* setInterval(
    () => {
      syncMarketplaceConversations()
        .catch(
          error => {
            console.warn(
              "[CONVERSATION TRACKER] Periodic sync failed:",
              error
            );
          }
        );
    },
    MARKETPLACE_CONVERSATION_TRACKER_INTERVAL_MS
  );*/
}

if (window.location.hostname.includes("facebook.com")) {
  addButton();
  addAutoAnalyzerButtons();
  addSavedDealsButton();
  addScamListingsButton();
  addSessionListingsButton();
  addLibrarySavingToggleButton();
  startMarketplaceAutoStatsPanelLoop();
  startMarketplaceConversationTracker();

  setInterval(() => {
    addButton();
    addAutoAnalyzerButtons();
    addSavedDealsButton();
    addScamListingsButton();
    addSessionListingsButton();
    addLibrarySavingToggleButton();
  }, 1000);

 (async () => {
  try {
    const malformedJsonRestartHandled =
      await resumeMalformedJsonListingRestartIfNeeded();

    if (!malformedJsonRestartHandled) {
      await resumeMarketplaceAutoAnalyzerIfNeeded();
    }
  } catch (error) {
    console.error(
      "Facebook Marketplace startup/resume failed:",
      error
    );
  }
})();
}

if (
  window.location.hostname.includes("ebay.com") &&
  window.location.pathname.includes("/sch/")
) {
  runEbayCompAnalyzer();
}