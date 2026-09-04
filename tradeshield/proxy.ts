import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {

const hostname =
  String(
    request.headers.get(
      "host"
    ) ||
    ""
  )
    .split(":")[0]
    .toLowerCase();


if (
  hostname ===
  "checklist.tradeshieldverify.com"
) {
  const pathname =
    request.nextUrl.pathname;


  /*
    Do NOT rewrite Next.js internals.
  */
  if (
    pathname.startsWith(
      "/_next/"
    ) ||
    pathname ===
      "/favicon.ico"
  ) {
    return NextResponse.next();
  }


  /*
    Checklist browser API already exists
    at its real internal path.
  */
  if (
    pathname.startsWith(
      "/api/checklists/"
    )
  ) {
    return NextResponse.next();
  }


  /*
    Prevent rewriting something that has
    already been internally rewritten.
  */
  if (
    pathname.startsWith(
      "/checklist/"
    )
  ) {
    return NextResponse.next();
  }


  /*
    PUBLIC:
      checklist.tradeshieldverify.com/ABC

    INTERNAL:
      /checklist/ABC
  */

  const rewriteUrl =
    request.nextUrl.clone();


  rewriteUrl.pathname =
    `/checklist${pathname}`;


  return NextResponse.rewrite(
    rewriteUrl
  );
}

  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },

        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          response = NextResponse.next({
            request,
          });

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  await supabase.auth.getClaims();

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};