import {
  NextRequest,
  NextResponse
} from "next/server";

import {
  saveDealChecklistItem
} from "@/lib/deal-checklist";


export async function PATCH(
  request: NextRequest,

  {
    params
  }: {
    params:
      Promise<{
        token: string;
      }>;
  }
) {
  try {
    const {
      token
    } =
      await params;


    const body =
      await request.json();


    const itemKey =
      String(
        body?.itemKey ||
        ""
      ).trim();


    if (!itemKey) {
      return NextResponse.json(
        {
          ok:
            false,

          error:
            "Missing itemKey."
        },
        {
          status:
            400
        }
      );
    }


    const checked =
      body?.checked ===
      true;


    const saved =
      await saveDealChecklistItem({
        token,
        itemKey,
        checked
      });


    return NextResponse.json({
      ok:
        true,

      ...saved
    });


  } catch (error) {
    console.error(
      "[CHECKLIST API] Save failed:",
      error
    );


    const message =
      error instanceof Error
        ? error.message
        : "Could not save checklist.";


    const status =
      message ===
      "Checklist not found."
        ? 404
        : 500;


    return NextResponse.json(
      {
        ok:
          false,

        error:
          message
      },
      {
        status
      }
    );
  }
}