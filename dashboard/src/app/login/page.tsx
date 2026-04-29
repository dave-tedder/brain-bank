import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { APP } from "@/config/app";
import { signSessionToken } from "@/lib/auth";

async function login(formData: FormData) {
  "use server";
  const password = formData.get("password") as string;
  const expected = process.env.DASHBOARD_PASSWORD;
  if (expected && password === expected) {
    const sessionToken = await signSessionToken(expected);
    const cookieStore = await cookies();
    cookieStore.set("bb-auth", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });
    redirect("/");
  }
  redirect("/login?error=1");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        background:
          "radial-gradient(circle at center, rgba(0, 255, 65, 0.04) 0%, transparent 60%)",
      }}
    >
      <form action={login} className="w-80 space-y-5 card scanline-hover p-8">
        {/* Title block */}
        <div className="text-center space-y-1">
          <h1
            className="font-terminal text-5xl text-glow animate-in stagger-0"
            style={{ color: "var(--text-primary)" }}
          >
            {APP.name.toUpperCase()}
          </h1>
          <p
            className="animate-in stagger-1"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.25em",
              color: "var(--text-muted)",
            }}
          >
            {APP.loginSubtitle}
          </p>
        </div>

        {/* Error state */}
        {params.error && (
          <div
            className="animate-in stagger-2 text-sm text-center py-2 rounded"
            style={{
              color: "var(--danger)",
              background: "rgba(239, 68, 68, 0.1)",
              animation: "flicker 0.3s ease-in-out",
            }}
          >
            ACCESS DENIED
          </div>
        )}

        {/* Terminal prompt */}
        <div
          className={`font-terminal text-sm animate-in ${params.error ? "stagger-3" : "stagger-2"}`}
          style={{ color: "var(--text-primary)" }}
        >
          root@brain:~$
        </div>

        {/* Password input */}
        <input
          name="password"
          type="password"
          placeholder="enter access code..."
          autoFocus
          className={`login-input w-full px-4 py-3 animate-in ${params.error ? "stagger-4" : "stagger-3"}`}
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            fontFamily: "var(--font-mono)",
            color: "var(--text-primary)",
            outline: "none",
            transition: "border-color 200ms, box-shadow 200ms",
          }}
        />

        {/* Submit button */}
        <button
          type="submit"
          className={`login-button w-full px-4 py-3 font-terminal animate-in ${params.error ? "stagger-5" : "stagger-4"}`}
          style={{
            border: "1px solid var(--accent)",
            background: "transparent",
            color: "var(--text-primary)",
            borderRadius: "4px",
            fontSize: "1rem",
            cursor: "pointer",
            transition: "all 200ms",
          }}
        >
          AUTHENTICATE
        </button>
      </form>

      <style>{`
        @keyframes flicker {
          0%   { opacity: 1; }
          50%  { opacity: 0; }
          100% { opacity: 1; }
        }
        input::placeholder {
          color: var(--text-muted);
        }
        .login-input:focus {
          border-color: var(--border-active) !important;
          box-shadow: 0 0 12px rgba(0, 255, 65, 0.2);
        }
        .login-button:hover {
          background: var(--accent) !important;
          color: #0a0a0a !important;
        }
        .login-button:active {
          transform: scale(0.98);
        }
      `}</style>
    </div>
  );
}
