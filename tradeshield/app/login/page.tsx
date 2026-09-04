import { login } from "./actions";

export default function LoginPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f4f6f8",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "420px",
          background: "#ffffff",
          padding: "30px",
          borderRadius: "12px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
        }}
      >
        <h1 style={{ marginTop: 0 }}>
          TradeShield Admin
        </h1>

        <p style={{ color: "#6b7280" }}>
          Sign in to access the transaction dashboard.
        </p>

        <form action={login}>
          <label style={labelStyle}>
            Email
          </label>

          <input
            name="email"
            type="email"
            required
            style={inputStyle}
          />

          <label style={labelStyle}>
            Password
          </label>

          <input
            name="password"
            type="password"
            required
            style={inputStyle}
          />

          <button
            type="submit"
            style={{
              width: "100%",
              marginTop: "24px",
              padding: "13px",
              border: "none",
              borderRadius: "8px",
              background: "#111827",
              color: "#ffffff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Sign In
          </button>
        </form>
      </div>
    </main>
  );
}

const labelStyle = {
  display: "block",
  marginTop: "18px",
  marginBottom: "7px",
  fontWeight: 600,
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "12px",
  border: "1px solid #d1d5db",
  borderRadius: "7px",
  color: "#111827",
  background: "#ffffff",
};