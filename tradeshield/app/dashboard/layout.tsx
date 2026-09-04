import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  console.log("Dashboard auth user:", user?.email);
  console.log("Dashboard auth error:", error?.message);

  if (!user) {
    redirect("/login");
  }

  return <>{children}</>;
}