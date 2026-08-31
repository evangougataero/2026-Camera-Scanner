import "dotenv/config";

const DATAFORSEO_LOGIN =
  String(process.env.DATAFORSEO_LOGIN || "").trim();

const DATAFORSEO_PASSWORD =
  String(process.env.DATAFORSEO_PASSWORD || "").trim();


if (
  !DATAFORSEO_LOGIN ||
  !DATAFORSEO_PASSWORD
) {
  throw new Error(
    "Missing DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD in .env"
  );
}


const IMAGE_URL =
  "https://scontent-sjc6-1.xx.fbcdn.net/v/t45.5328-4/715477899_3976700212466918_6698383827568511225_n.jpg?stp=dst-jpg_p720x720_tt6&_nc_cat=108&ccb=1-7&_nc_sid=247b10&_nc_ohc=fh_HDeQW35AQ7kNvwE7m5Xu&_nc_oc=AdrmbL0FdTgWOAo4UF2oTY0L5W8W3wvuSGvV71dAtjnVi09XMafFat3hOMuyJMoo1Js&_nc_zt=23&_nc_ht=scontent-sjc6-1.xx&_nc_gid=Qc3kIIKMgVEvbRTOYlU3sg&_nc_ss=7b2a8&oh=00_AQLxjT2JOPM487K6q7miIIgdQdXgjQQE8yHLRUV5tKXIIQ&oe=6A9A3C05";


if (
  !IMAGE_URL.startsWith("http://") &&
  !IMAGE_URL.startsWith("https://")
) {
  throw new Error(
    "IMAGE_URL must be a public http/https image URL."
  );
}


const auth =
  "Basic " +
  Buffer
    .from(
      `${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`
    )
    .toString("base64");


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


async function createTask() {
  console.log(
    "\n[1] Submitting image to DataForSEO..."
  );

  const response =
    await fetch(
      "https://api.dataforseo.com/v3/serp/google/search_by_image/task_post",
      {
        method: "POST",

        headers: {
          Authorization: auth,
          "Content-Type": "application/json"
        },

        body: JSON.stringify([
          {
            image_url: IMAGE_URL,

            location_code: 2840,

            language_code: "en",

            priority: 1
          }
        ])
      }
    );


  const data =
    await response.json();


  console.log(
    "\nPOST RESPONSE:"
  );

  console.log(
    JSON.stringify(
      data,
      null,
      2
    )
  );


  const task =
    data?.tasks?.[0];


  if (!task?.id) {
    throw new Error(
      task?.status_message ||
      data?.status_message ||
      "DataForSEO did not return a task ID."
    );
  }


  console.log(
    "\nTask ID:",
    task.id
  );


  console.log(
    "Task cost:",
    task.cost ?? "unknown"
  );


  return task.id;
}


async function getResult(
  taskId
) {
  const response =
    await fetch(
      `https://api.dataforseo.com/v3/serp/google/search_by_image/task_get/advanced/${encodeURIComponent(
        taskId
      )}`,
      {
        method: "GET",

        headers: {
          Authorization: auth,
          "Content-Type": "application/json"
        }
      }
    );


  return await response.json();
}


async function main() {
  const taskId =
    await createTask();


  console.log(
    "\n[2] Waiting for results..."
  );


  /*
    Normal-priority tasks are asynchronous.

    For this test, check every 10 seconds
    for up to 10 minutes.
  */
  const startedAt =
    Date.now();

  const timeoutMs =
    10 * 60 * 1000;


  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    await sleep(
      10000
    );


    const data =
      await getResult(
        taskId
      );


    const task =
      data?.tasks?.[0];


    console.log(
      "\nStatus:",
      task?.status_code,
      task?.status_message
    );


    if (
      Array.isArray(
        task?.result
      ) &&
      task.result.length > 0
    ) {
      console.log(
        "\n===================================="
      );

      console.log(
        "RESULT RECEIVED"
      );

      console.log(
        "====================================\n"
      );


      console.log(
        JSON.stringify(
          data,
          null,
          2
        )
      );


      /*
        Also save the complete response
        to a file for easier inspection.
      */
      const fs =
        await import("fs");


      fs.writeFileSync(
        "dataforseo-result.json",
        JSON.stringify(
          data,
          null,
          2
        ),
        "utf8"
      );


      console.log(
        "\nSaved complete result to:"
      );

      console.log(
        "dataforseo-result.json"
      );


      return;
    }
  }


  throw new Error(
    "Timed out waiting for DataForSEO."
  );
}


main()
  .catch(
    error => {
      console.error(
        "\nTEST FAILED:"
      );

      console.error(
        error
      );

      process.exitCode = 1;
    }
  );