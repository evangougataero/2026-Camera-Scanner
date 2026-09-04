import { createHash } from "crypto";

const VERIFICATION_TOKEN =
  process.env.EBAY_DELETION_VERIFICATION_TOKEN || "";

const ENDPOINT =
  "https://www.tradeshieldverify.com/api/ebay/account-deletion";

export async function GET(
  request: Request
) {
  try {
    const url =
      new URL(request.url);

    const challengeCode =
      url.searchParams.get(
        "challenge_code"
      );

    if (!challengeCode) {
      return Response.json(
        {
          error:
            "Missing challenge_code"
        },
        {
          status: 400
        }
      );
    }

    if (!VERIFICATION_TOKEN) {
      return Response.json(
        {
          error:
            "Verification token is not configured."
        },
        {
          status: 500
        }
      );
    }

    const challengeResponse =
      createHash("sha256")
        .update(
          challengeCode +
          VERIFICATION_TOKEN +
          ENDPOINT
        )
        .digest("hex");

    console.log(
      "[EBAY ACCOUNT DELETION] Verification challenge received."
    );

    return Response.json({
      challengeResponse
    });

  } catch (error) {
    console.error(
      "[EBAY ACCOUNT DELETION] Verification error:",
      error
    );

    return Response.json(
      {
        error:
          "Verification failed."
      },
      {
        status: 500
      }
    );
  }
}

export async function POST(
  request: Request
) {
  try {
    const payload =
      await request.json();

    console.log(
      "[EBAY ACCOUNT DELETION] Notification received:",
      payload
    );

    /*
      If you ever store data tied to an
      individual eBay user, delete or
      anonymize it here.
    */

    return new Response(
      null,
      {
        status: 204
      }
    );

  } catch (error) {
    console.error(
      "[EBAY ACCOUNT DELETION] Notification error:",
      error
    );

    return Response.json(
      {
        error:
          "Could not process notification."
      },
      {
        status: 500
      }
    );
  }
}