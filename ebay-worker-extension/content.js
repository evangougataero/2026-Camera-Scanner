console.log(
  "[EBAY WORKER] Content script loaded:",
  window.location.href
);


/*
  ============================================================
  PARSE PRICE
  ============================================================
*/

function parseEbayPrice(
  text
) {
  if (!text) {
    return null;
  }

  /*
    Preserve your main extension's behavior.
  */
  if (
    String(text)
      .toLowerCase()
      .includes(
        "to"
      )
  ) {
    return null;
  }

  const match =
    String(text)
      .match(
        /\$[\d,]+(\.\d{2})?/
      );

  if (!match) {
    return null;
  }

  return Number(
    match[0]
      .replace(
        "$",
        ""
      )
      .replace(
        /,/g,
        ""
      )
  );
}


/*
  ============================================================
  PARSE SOLD DATE
  ============================================================
*/

function parseEbaySoldDate(
  text
) {
  if (!text) {
    return null;
  }

  const cleaned =
    String(text)
      .replace(
        /\s+/g,
        " "
      );

  const match =
    cleaned.match(
      /Sold\s+([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})?/i
    );

  if (!match) {
    return null;
  }

  const month =
    match[1];

  const day =
    match[2];

  const year =
    match[3] ||
    new Date()
      .getFullYear();

  const date =
    new Date(
      `${month} ${day}, ${year}`
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  /*
    If eBay omitted the year and our interpretation
    would be in the future, it belongs to last year.
  */
  if (
    !match[3] &&
    date >
      new Date()
  ) {
    date.setFullYear(
      date.getFullYear() -
        1
    );
  }

  return date.toISOString();
}

/*
  ============================================================
  WAIT FOR EBAY RESULTS
  ============================================================
*/

function waitForEbayListings(
  timeoutMs = 10000
) {
  return new Promise(
    resolve => {
      const startedAt =
        Date.now();

      const interval =
        setInterval(
          () => {
            const pageText =
              document.body
                ?.innerText ||
              "";

            const hasSoldText =
              pageText.includes(
                "Sold "
              );

            const hasPrices =
              /\$[\d,]+(\.\d{2})?/
                .test(
                  pageText
                );

            const hasItemLinks =
              document
                .querySelectorAll(
                  "a[href*='/itm/']"
                )
                .length >
              0;


            if (
              (
                hasSoldText &&
                hasPrices
              ) ||
              hasItemLinks
            ) {
              clearInterval(
                interval
              );

              resolve(
                true
              );

              return;
            }


            if (
              Date.now() -
                startedAt >
              timeoutMs
            ) {
              clearInterval(
                interval
              );

              resolve(
                false
              );
            }

          },
          500
        );
    }
  );
}

/*
  ============================================================
  SCRAPE EBAY SOLD LISTINGS

  Keep this synchronized with the main scanner's
  extractEbaySoldListings().
  ============================================================
*/

function extractEbaySoldListings() {
  const itemLinks =
    Array.from(
      document.querySelectorAll(
        "a[href*='/itm/']"
      )
    );


  console.log(
    "[EBAY WORKER] Item links found:",
    itemLinks.length
  );


  function findListingContainer(
    link
  ) {
    let node =
      link;

    for (
      let i = 0;
      i < 8;
      i++
    ) {
      if (!node) {
        return null;
      }


      const text =
        node.innerText ||
        "";


      const hasSold =
        /Sold\s+[A-Za-z]{3,9}\s+\d{1,2}/i
          .test(
            text
          );


      const hasPrice =
        /\$[\d,]+(\.\d{2})?/
          .test(
            text
          );


      const textLongEnough =
        text.length >
        40;


      if (
        hasSold &&
        hasPrice &&
        textLongEnough
      ) {
        return node;
      }


      node =
        node.parentElement;
    }


    return null;
  }


  const containers =
    itemLinks
      .map(
        link =>
          findListingContainer(
            link
          )
      )
      .filter(
        Boolean
      );


  const uniqueContainers =
    [
      ...new Set(
        containers
      )
    ];


  console.log(
    "[EBAY WORKER] Containers found:",
    uniqueContainers.length
  );


  const listings =
    uniqueContainers.map(
      container => {
        const allText =
          container.innerText ||
          "";


        const linkEl =
          container.querySelector(
            "a[href*='/itm/']"
          ) ||
          null;


        let title =
          linkEl
            ?.innerText
            ?.trim() ||

          linkEl
            ?.getAttribute(
              "aria-label"
            )
            ?.trim() ||

          "";


        title =
          title
            .replace(
              /\s+/g,
              " "
            )
            .replace(
              /^Opens in a new window or tab\s*/i,
              ""
            )
            .trim();


        const priceMatch =
          allText.match(
            /\$[\d,]+(\.\d{2})?/
          );


        const priceText =
          priceMatch
            ? priceMatch[0]
            : "";


        const price =
          parseEbayPrice(
            priceText
          );


        const soldDate =
          parseEbaySoldDate(
            allText
          );


        let condition =
          "";


        const conditionMatch =
          allText.match(
            /\b(Open Box|Used|Pre-Owned|Parts Only|For parts or not working|For parts|Not Working|Brand New|New other|New with defects)\b/i
          );


        if (
          conditionMatch
        ) {
          condition =
            conditionMatch[0];


          if (
            /^new$/i.test(
              condition
            ) &&
            /new listing/i.test(
              allText
            )
          ) {
            condition =
              "";
          }
        }


        const imageUrl =
          container
            .querySelector(
              "img"
            )
            ?.src ||
          "";


        const link =
          linkEl?.href ||
          "";


        const bestOfferAccepted =
          /best offer accepted/i
            .test(
              allText
            );


        return {
          title,
          price,
          priceText,
          condition,
          soldDate,
          link,
          imageUrl,
          bestOfferAccepted,

          rawText:
            allText.slice(
              0,
              800
            )
        };
      }
    );


  /*
    Same cleanup used by main scanner.
  */
  const cleanedListings =
    listings

      .filter(
        item =>
          item.title
      )

      .filter(
        item =>
          item.price
      )

      .filter(
        item =>
          item.soldDate
      )

      .filter(
        item =>
          !item.title
            .toLowerCase()
            .includes(
              "shop on ebay"
            )
      )

      .filter(
        item =>
          !item.title
            .toLowerCase()
            .includes(
              "results matching fewer words"
            )
      )

      .slice(
        0,
        60
      );


  console.log(
    "[EBAY WORKER] Cleaned listings:",
    cleanedListings
  );


  return cleanedListings;
}

/*
  ============================================================
  BACKGROUND.JS → EBAY PAGE
  ============================================================
*/

chrome.runtime.onMessage.addListener(
  (
    message,
    sender,
    sendResponse
  ) => {
    if (
      message?.type !==
      "SCRAPE_EBAY_RESULTS"
    ) {
      return;
    }


    (
      async () => {
        try {
          /*
            Wait until eBay has rendered results.
          */
          const found =
            await waitForEbayListings(
              10000
            );


          console.log(
            "[EBAY WORKER] Results readiness:",
            found
          );


          /*
            Small extra rendering delay.
          */
          if (found) {
            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  500
                )
            );
          }


          const listings =
            extractEbaySoldListings();


          console.log(
            "[EBAY WORKER] Returning:",
            listings.length,
            "listings"
          );


          sendResponse({
            ok:
              true,

            listings,

            pageUrl:
              window.location.href
          });


        } catch (error) {
          console.error(
            "[EBAY WORKER] Scrape failed:",
            error
          );


          sendResponse({
            ok:
              false,

            listings:
              [],

            error:
              error?.message ||
              String(error)
          });
        }
      }
    )();


    /*
      Keep message channel alive because scraping
      happens asynchronously.
    */
    return true;
  }
);