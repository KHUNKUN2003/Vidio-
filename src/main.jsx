import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildEmbedUrl } from "../admin-utils.mjs";
import "./styles.css";

const DEFAULT_VIDEO_ID = "Xx_69DYLHt4";

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function App() {
  const [session, setSession] = useState(() => {
    const saved = sessionStorage.getItem("course-session");
    return saved ? JSON.parse(saved) : null;
  });
  const [roleTab, setRoleTab] = useState("admin");
  const [videos, setVideos] = useState([]);
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0 });
  const [selectedVideoId, setSelectedVideoId] = useState(DEFAULT_VIDEO_ID);
  const [, setApiError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [authNotice, setAuthNotice] = useState(null);

  const selectedVideo = useMemo(
    () => videos.find((video) => video.youtube_video_id === selectedVideoId),
    [selectedVideoId, videos],
  );

  function saveSession(nextSession) {
    setSession(nextSession);
    if (nextSession) {
      setAuthNotice(null);
      sessionStorage.setItem("course-session", JSON.stringify(nextSession));
    } else {
      sessionStorage.removeItem("course-session");
    }
  }

  async function refreshData() {
    setIsLoading(true);
    try {
      setApiError("");
      const [videoResponse, dashboardResponse] = await Promise.all([
        fetch("/api/videos"),
        fetch("/api/dashboard"),
      ]);

      if (!videoResponse.ok || !dashboardResponse.ok) {
        throw new Error("เชื่อมต่อ PostgreSQL API ไม่สำเร็จ");
      }

      const videoData = await videoResponse.json();
      const dashboardData = await dashboardResponse.json();
      setVideos(videoData);
      setStats(dashboardData);
      if (!videoData.some((video) => video.youtube_video_id === selectedVideoId)) {
        setSelectedVideoId(videoData[0]?.youtube_video_id || DEFAULT_VIDEO_ID);
      }
    } catch (error) {
      setApiError(error.message);
      setVideos([]);
      setStats({ total: 0, active: 0, inactive: 0 });
    } finally {
      setIsLoading(false);
    }
  }

  async function logout() {
    const currentSession = session;
    saveSession(null);

    if (!currentSession?.token) return;

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: authHeaders(currentSession.token),
      });
    } catch {
      // The local session is already cleared; the server-side session will expire automatically.
    }
  }

  useEffect(() => {
    if (session) refreshData();
  }, [session]);

  useEffect(() => {
    if (session?.role !== "user" || !session.token) return undefined;

    let isActive = true;
    const sendHeartbeat = async () => {
      try {
        const response = await fetch("/api/auth/heartbeat", {
          method: "POST",
          headers: authHeaders(session.token),
        });

        if (!isActive || response.ok) return;

        setAuthNotice({
          title: "เซสชันหมดอายุ",
          message: "บัญชีนี้ไม่ได้ใช้งานต่อเนื่องหรือถูกเปิดใช้งานจากอุปกรณ์อื่น กรุณาเข้าสู่ระบบใหม่",
          type: "error",
        });
        setRoleTab("user");
        saveSession(null);
      } catch {
        // Keep the current session during a temporary network issue.
      }
    };

    const intervalId = window.setInterval(sendHeartbeat, 30000);
    sendHeartbeat();

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [session]);

  useEffect(() => {
    if (session?.provider !== "line" || !session.lineUserId) return undefined;

    let isActive = true;
    const verifyLineMembership = async () => {
      try {
        const params = new URLSearchParams({ lineUserId: session.lineUserId });
        const response = await fetch(`/api/auth/line/status?${params.toString()}`, {
          headers: authHeaders(session.token),
        });
        const data = await response.json().catch(() => null);

        if (!isActive) return;

        if (!response.ok || !data.canWatch) {
          setAuthNotice({
            title: "สิทธิ์ถูกเปลี่ยนแล้ว",
            message: "บัญชี LINE นี้ถูกปฏิเสธหรือไม่มีสิทธิ์ใช้งานแล้ว กรุณาติดต่อ admin",
            type: "error",
          });
          setRoleTab("user");
          saveSession(null);
        }
      } catch {
        // Keep the current session if the status check fails because of a temporary network issue.
      }
    };

    const intervalId = window.setInterval(verifyLineMembership, 2000);
    verifyLineMembership();

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [session]);

  if (!session) {
    return (
      <AuthScreen
        notice={authNotice}
        roleTab={roleTab}
        onRoleChange={setRoleTab}
        onLogin={saveSession}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="kicker">{session.role === "admin" ? "Admin" : session.phone || session.lineName}</p>
          <h1>{session.role === "admin" ? "Vidio+" : "Private Viewer"}</h1>
        </div>
        <button className="ghost-button" type="button" onClick={logout}>
          ออกจากระบบ
        </button>
      </header>

      {session.role === "admin" && (
        <AdminDashboard
          stats={stats}
          videos={videos}
          isLoading={isLoading}
          token={session.token}
          onRefresh={refreshData}
          onSelect={setSelectedVideoId}
          onVideosReordered={setVideos}
        />
      )}

      <WatchArea
        videos={videos}
        isLoading={isLoading}
        selectedVideoId={selectedVideoId}
        selectedVideo={selectedVideo}
        onSelect={setSelectedVideoId}
      />
    </main>
  );
}

function AuthScreen({ notice, roleTab, onRoleChange, onLogin }) {
  const [adminMessage, setAdminMessage] = useState("");
  const [otpMessage, setOtpMessage] = useState("");
  const [lineRequest, setLineRequest] = useState(null);
  const [pendingPhone, setPendingPhone] = useState("");
  const [otpStep, setOtpStep] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  function showToast(nextToast) {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ id: Date.now(), ...nextToast });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  }

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (notice) showToast(notice);
  }, [notice]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lineError = params.get("line_error");
    const resultCode = params.get("line_result");
    if (!lineError && !resultCode) return;

    window.history.replaceState({}, "", window.location.pathname);
    onRoleChange("user");

    if (lineError) {
      const messages = {
        line_config_missing: "ยังไม่ได้ตั้งค่า LINE Channel ID/Secret ใน .env",
        line_cancelled: "การเข้าสู่ระบบ LINE ถูกยกเลิก",
        line_state_invalid: "สถานะการเข้าสู่ระบบ LINE ไม่ถูกต้อง กรุณาลองใหม่",
        line_token_failed: "แลก token จาก LINE ไม่สำเร็จ",
        line_profile_failed: "ดึงโปรไฟล์ LINE ไม่สำเร็จ",
      };
      showToast({
        title: "Login with LINE ไม่สำเร็จ",
        message: messages[lineError] || "กรุณาลองใหม่อีกครั้ง",
        type: "error",
      });
      return;
    }

    async function completeLineLogin() {
      const response = await fetch(`/api/auth/line/session?code=${encodeURIComponent(resultCode)}`);
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        showToast({
          title: "Login with LINE ไม่สำเร็จ",
          message: data?.error || "ผลการเข้าสู่ระบบหมดอายุ กรุณาลองใหม่",
          type: "error",
        });
        return;
      }

      if (data.canWatch && data.token) {
        onLogin({ role: "user", token: data.token, provider: "line", lineName: data.user.lineName, lineUserId: data.user.lineUserId });
        return;
      }

      setLineRequest(data.request);
    }

    completeLineLogin();
  }, []);

  async function submitAdmin(event) {
    event.preventDefault();
    setAdminMessage("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: String(form.get("username") || ""),
        password: String(form.get("password") || ""),
      }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      setAdminMessage(data?.error || "Username หรือ password ไม่ถูกต้อง");
      return;
    }

    onLogin({ role: "admin", token: data.token, username: data.user.username });
  }

  async function submitPhone(event) {
    event.preventDefault();
    setOtpMessage("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/user/request-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: String(form.get("phone") || "") }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      setOtpMessage(data?.error || "กรุณากรอกเบอร์โทรให้ถูกต้อง เช่น 0812345678");
      return;
    }

    setPendingPhone(data.phone);
    setOtpStep(true);
    setOtpMessage(`ส่ง OTP ไปยัง ${data.phone} แล้ว (โหมดทดสอบ: ${data.demoOtp})`);
  }

  async function submitOtp(event) {
    event.preventDefault();
    setOtpMessage("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/user/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: pendingPhone,
        otp: String(form.get("otp") || ""),
      }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      showToast({
        title: "เข้าสู่ระบบไม่ได้",
        message: data?.error || "OTP ไม่ถูกต้องหรือหมดอายุ",
        type: "error",
      });
      return;
    }

    onLogin({ role: "user", token: data.token, phone: data.user.phone });
  }

  async function submitLineLogin(event) {
    event.preventDefault();
    setOtpMessage("");
    window.location.href = "/api/auth/line/start";
  }

  useEffect(() => {
    if (!lineRequest || lineRequest.status !== "pending") return undefined;

    let isActive = true;
    const pollMembershipStatus = async () => {
      try {
        const params = new URLSearchParams({ lineUserId: lineRequest.line_user_id });
        const response = await fetch(`/api/auth/line/status?${params.toString()}`);
        const data = await response.json().catch(() => null);

        if (!isActive) return;

        if (!response.ok) {
          showToast({
            title: "เข้าใช้งานไม่ได้",
            message: data?.error || "บัญชีนี้ยังไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง",
            type: "error",
          });
          if (response.status === 409) {
            setLineRequest(null);
          }
          return;
        }

        if (data.canWatch && data.token) {
          onLogin({ role: "user", token: data.token, provider: "line", lineName: data.user.lineName, lineUserId: data.user.lineUserId });
          return;
        }

        setLineRequest(data.request);
      } catch {
        // Keep waiting; the next poll will retry.
      }
    };

    const intervalId = window.setInterval(pollMembershipStatus, 2000);
    pollMembershipStatus();

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [lineRequest, onLogin]);

  if (lineRequest) {
    const isRejected = lineRequest.status === "rejected";

    return (
      <section className="auth-screen">
        <div className={isRejected ? "auth-card pending-card is-rejected" : "auth-card pending-card"}>
          <span className="pending-mark" aria-hidden="true">{isRejected ? "!" : "..."}</span>
          <div className="auth-copy">
            <p className="kicker">Membership Request</p>
            <h1>{isRejected ? "คำขอไม่ผ่าน" : "รอ admin อนุมัติ"}</h1>
            <p>
              {isRejected
                ? `คำขอของ ${lineRequest.line_name} ถูกปฏิเสธ กรุณาติดต่อ admin หรือส่งคำขอใหม่อีกครั้ง`
                : `คำขอของ ${lineRequest.line_name} ถูกส่งเข้า dashboard แล้ว หน้านี้จะอัปเดตอัตโนมัติเมื่อ admin อนุมัติหรือปฏิเสธ`}
            </p>
          </div>
          <button className="primary-button" type="button" onClick={() => setLineRequest(null)}>
            กลับไปหน้าเข้าสู่ระบบ
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-screen">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="auth-card">
        <div className="auth-copy">
          <p className="kicker">Private YouTube Viewer</p>
          <h1>เข้าสู่ระบบเพื่อดูคลิป</h1>
          <p>พื้นที่ดูวิดีโอแบบเรียบง่ายสำหรับผู้ใช้ และมี dashboard สำหรับ admin จัดการคลิป</p>
        </div>

        <div className="role-tabs" aria-label="เลือกบทบาท">
          <button className={roleTab === "admin" ? "is-active" : ""} onClick={() => onRoleChange("admin")} type="button">
            Admin
          </button>
          <button className={roleTab === "user" ? "is-active" : ""} onClick={() => onRoleChange("user")} type="button">
            User
          </button>
        </div>

        {roleTab === "admin" ? (
          <form className="form-stack" onSubmit={submitAdmin}>
            <label>
              Username
              <input name="username" autoComplete="username" placeholder="กรอกชื่อผู้ใช้" required />
            </label>
            <label>
              Password
              <span className="password-field">
                <input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="กรอกรหัสผ่าน" required />
                <button type="button" onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? "ซ่อน" : "แสดง"}
                </button>
              </span>
            </label>
            <button className="primary-button" type="submit">เข้าสู่ระบบ Admin</button>
            <p className="form-message">{adminMessage}</p>
          </form>
        ) : (
          <div className="form-stack">
            {!otpStep ? (
              <form className="form-stack" key="phone-form" onSubmit={submitPhone}>
                <label>
                  เบอร์โทรศัพท์
                  <input name="phone" type="tel" placeholder="0812345678" required />
                </label>
                <button className="primary-button" type="submit">ส่ง OTP</button>
              </form>
            ) : (
              <form className="form-stack" key={`otp-form-${pendingPhone}`} onSubmit={submitOtp}>
                <label>
                  OTP
                  <input key={`otp-input-${pendingPhone}`} name="otp" inputMode="numeric" maxLength="6" placeholder="กรอก OTP 6 หลัก" required />
                </label>
                <div className="button-row">
                  <button className="primary-button" type="submit">ยืนยัน OTP</button>
                  <button type="button" onClick={() => { setOtpStep(false); setPendingPhone(""); }}>
                    เปลี่ยนเบอร์
                  </button>
                </div>
              </form>
            )}
            {!otpStep && (
              <>
                <div className="auth-divider"><span>หรือ</span></div>
                <form className="form-stack" onSubmit={submitLineLogin}>
                  <button className="line-login-button" type="submit">Login with LINE</button>
                </form>
              </>
            )}
            <p className={otpMessage.includes("ไม่") ? "form-message" : "form-message success-message"}>{otpMessage}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function AdminDashboard({ stats, videos, isLoading, token, onRefresh, onSelect, onVideosReordered }) {
  const emptyForm = { title: "", url: "", description: "", isActive: true };
  const [activePanel, setActivePanel] = useState("videos");
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [membershipRequests, setMembershipRequests] = useState([]);
  const [isMembershipLoading, setIsMembershipLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [pendingDeleteVideo, setPendingDeleteVideo] = useState(null);
  const [pendingDeleteMembership, setPendingDeleteMembership] = useState(null);
  const [draggedVideoId, setDraggedVideoId] = useState(null);
  const toastTimerRef = useRef(null);

  function showToast(nextToast) {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ id: Date.now(), ...nextToast });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  }

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  async function refreshMembershipRequests(silent = false) {
    if (!silent) setIsMembershipLoading(true);
    try {
      const response = await fetch("/api/memberships", {
        headers: authHeaders(token),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        showToast({ title: "โหลดคำขอไม่สำเร็จ", message: data?.error || "กรุณาลองใหม่อีกครั้ง", type: "error" });
        return;
      }
      setMembershipRequests(data);
    } finally {
      if (!silent) setIsMembershipLoading(false);
    }
  }

  useEffect(() => {
    if (!token) return undefined;

    refreshMembershipRequests();
    const intervalId = window.setInterval(() => refreshMembershipRequests(true), 3000);
    return () => window.clearInterval(intervalId);
  }, [token]);

  async function updateMembershipStatus(request, status) {
    const response = await fetch(`/api/memberships/${request.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ status }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      showToast({ title: "อัปเดตคำขอไม่สำเร็จ", message: data?.error || "กรุณาลองใหม่อีกครั้ง", type: "error" });
      return;
    }

    setMembershipRequests((requests) => requests.map((item) => (item.id === data.id ? data : item)));
    showToast({
      title: status === "approved" ? "อนุมัติสมาชิกแล้ว" : "ปฏิเสธคำขอแล้ว",
      message: `${request.line_name} ถูกอัปเดตเป็น ${status}`,
      type: "success",
    });
  }

  async function deleteMembershipRequest(request) {
    const response = await fetch(`/api/memberships/${request.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      showToast({ title: "ลบคำขอไม่สำเร็จ", message: data?.error || "กรุณาลองใหม่อีกครั้ง", type: "error" });
      return;
    }

    setMembershipRequests((requests) => requests.filter((item) => item.id !== request.id));
    setPendingDeleteMembership(null);
    showToast({ title: "ลบคำขอแล้ว", message: `คำขอของ ${request.line_name} ถูกนำออกจากรายการแล้ว`, type: "success" });
  }

  async function submitVideo(event) {
    event.preventDefault();
    const endpoint = editingId ? `/api/videos/${editingId}` : "/api/videos";
    const method = editingId ? "PUT" : "POST";
    const response = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(form),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const errorMessage = data?.error || "บันทึกวิดีโอไม่สำเร็จ";
      showToast({ title: "ไม่สำเร็จ", message: errorMessage, type: "error" });
      return;
    }
    setForm(emptyForm);
    setEditingId(null);
    showToast({
      title: editingId ? "อัปเดตสำเร็จ" : "อัปโหลดสำเร็จ",
      message: editingId ? "บันทึกการแก้ไขวิดีโอเรียบร้อยแล้ว" : "เพิ่มคลิปใหม่เข้า dashboard เรียบร้อยแล้ว",
      type: "success",
    });
    await onRefresh();
  }

  function editVideo(video) {
    setEditingId(video.id);
    setForm({
      title: video.title,
      url: video.youtube_url,
      description: video.description || "",
      isActive: video.is_active,
    });
    onSelect(video.youtube_video_id);
  }

  async function deleteVideo(video) {
    const response = await fetch(`/api/videos/${video.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    if (!response.ok) {
      showToast({ title: "ลบไม่สำเร็จ", message: "กรุณาลองใหม่อีกครั้ง", type: "error" });
      return;
    }
    setPendingDeleteVideo(null);
    showToast({ title: "ลบวิดีโอแล้ว", message: `"${video.title}" ถูกนำออกจากรายการแล้ว`, type: "success" });
    await onRefresh();
  }

  async function reorderVideos(targetVideoId) {
    if (!draggedVideoId || draggedVideoId === targetVideoId) return;

    const fromIndex = videos.findIndex((video) => video.id === draggedVideoId);
    const toIndex = videos.findIndex((video) => video.id === targetVideoId);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextVideos = [...videos];
    const [movedVideo] = nextVideos.splice(fromIndex, 1);
    nextVideos.splice(toIndex, 0, movedVideo);
    onVideosReordered(nextVideos);

    try {
      const response = await fetch("/api/videos/order", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ ids: nextVideos.map((video) => video.id) }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        showToast({ title: "จัดลำดับไม่สำเร็จ", message: data?.error || "กรุณาลองใหม่อีกครั้ง", type: "error" });
        await onRefresh();
        return;
      }

      onVideosReordered(data);
      showToast({ title: "บันทึกลำดับแล้ว", message: "ลำดับวิดีโอถูกอัปเดตเรียบร้อยแล้ว", type: "success" });
    } finally {
      setDraggedVideoId(null);
    }
  }

  return (
    <section className="dashboard">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <ConfirmDialog
        video={pendingDeleteVideo}
        onCancel={() => setPendingDeleteVideo(null)}
        onConfirm={() => pendingDeleteVideo && deleteVideo(pendingDeleteVideo)}
      />
      <ConfirmDialog
        title="ลบคำขอนี้ใช่ไหม?"
        message={pendingDeleteMembership ? `คำขอของ ${pendingDeleteMembership.line_name} จะถูกนำออกจากรายการคำขอสมาชิก` : ""}
        confirmLabel="ยืนยันลบ"
        isOpen={Boolean(pendingDeleteMembership)}
        onCancel={() => setPendingDeleteMembership(null)}
        onConfirm={() => pendingDeleteMembership && deleteMembershipRequest(pendingDeleteMembership)}
      />
      <div className="admin-panel-tabs">
        <button className={activePanel === "videos" ? "is-active" : ""} type="button" onClick={() => setActivePanel("videos")}>
          วิดีโอ
        </button>
        <button className={activePanel === "requests" ? "is-active" : ""} type="button" onClick={() => setActivePanel("requests")}>
          คำขอสมาชิก
          {membershipRequests.filter((request) => request.status === "pending").length > 0 && (
            <span>{membershipRequests.filter((request) => request.status === "pending").length}</span>
          )}
        </button>
      </div>

      {activePanel === "videos" ? (
        <>
          <div className="stat-grid">
            {isLoading && !videos.length ? (
              <>
                <StatSkeleton />
                <StatSkeleton />
                <StatSkeleton />
              </>
            ) : (
              <>
                <Stat label="ทั้งหมด" value={stats.total} />
                <Stat label="เปิดใช้งาน" value={stats.active} />
                <Stat label="ปิดใช้งาน" value={stats.inactive} />
              </>
            )}
          </div>

          <form className="editor-panel" onSubmit={submitVideo}>
            <div>
              <h2>{editingId ? "แก้ไขวิดีโอ" : "เพิ่มวิดีโอ"}</h2>
            </div>
            <label>
              ชื่อวิดีโอ
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
            </label>
            <label>
              YouTube URL
              <input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} required />
            </label>
            <label>
              คำอธิบาย
              <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </label>
            <div className="switch-row">
              <button
                aria-checked={form.isActive}
                aria-label="เปิดให้ user เห็น"
                className={form.isActive ? "toggle-switch is-on" : "toggle-switch"}
                onClick={() => setForm({ ...form, isActive: !form.isActive })}
                role="switch"
                type="button"
              >
                <span />
              </button>
              <span>เปิดให้ user เห็น</span>
            </div>
            <div className="button-row">
              <button className="primary-button" type="submit">{editingId ? "อัปเดต" : "เพิ่ม"}</button>
              {editingId && <button type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }}>ยกเลิก</button>}
            </div>
          </form>

          <div className="table-panel">
            <div className="table-heading">
              <h2>รายการวิดีโอ</h2>
              <button type="button" onClick={onRefresh}>รีเฟรช</button>
            </div>
            <div className="video-table">
              {isLoading && !videos.length ? (
                <>
                  <VideoRowSkeleton />
                  <VideoRowSkeleton />
                </>
              ) : videos.map((video) => (
                <article
                  className={draggedVideoId === video.id ? "video-row is-dragging" : "video-row"}
                  draggable
                  key={video.id}
                  onDragEnd={() => setDraggedVideoId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDragStart={(event) => {
                    if (event.target.closest(".row-actions")) {
                      event.preventDefault();
                      return;
                    }

                    setDraggedVideoId(video.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", video.id);
                  }}
                  onDrop={() => reorderVideos(video.id)}
                >
                  <button
                    aria-label={`ลากเพื่อจัดลำดับ ${video.title}`}
                    className="drag-handle"
                    type="button"
                  >
                    <span aria-hidden="true">⋮⋮</span>
                  </button>
                  <div>
                    <strong>{video.title}</strong>
                    <span>{video.youtube_video_id} / {video.is_active ? "active" : "inactive"}</span>
                  </div>
                  <div className="row-actions">
                    <button type="button" onClick={() => onSelect(video.youtube_video_id)}>ดู</button>
                    <button type="button" onClick={() => editVideo(video)}>แก้ไข</button>
                    <button className="danger-button" type="button" onClick={() => setPendingDeleteVideo(video)}>ลบ</button>
                  </div>
                </article>
              ))}
              {!isLoading && !videos.length && <p className="empty-state">ยังไม่มีข้อมูลจาก PostgreSQL</p>}
            </div>
          </div>
        </>
      ) : (
        <MembershipRequestsPanel
          isLoading={isMembershipLoading}
          requests={membershipRequests}
          onRefresh={refreshMembershipRequests}
          onUpdateStatus={updateMembershipStatus}
          onDelete={setPendingDeleteMembership}
        />
      )}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MembershipRequestsPanel({ isLoading, requests, onRefresh, onUpdateStatus, onDelete }) {
  const pendingCount = requests.filter((request) => request.status === "pending").length;

  return (
    <div className="table-panel membership-panel">
      <div className="table-heading">
        <div>
          <h2>คำขอสมาชิก</h2>
          <p>{pendingCount ? `มีคำขอรออนุมัติ ${pendingCount} รายการ` : "ยังไม่มีคำขอที่ต้องรออนุมัติ"}</p>
        </div>
        <button type="button" onClick={onRefresh}>รีเฟรช</button>
      </div>
      <div className="membership-list">
        {isLoading ? (
          <>
            <MembershipRequestSkeleton />
            <MembershipRequestSkeleton />
          </>
        ) : requests.length ? requests.map((request) => (
          <article className="membership-card" key={request.id}>
            <div>
              <strong>{request.line_name}</strong>
              <span>LINE ID: {request.line_user_id}</span>
              <small>ส่งคำขอเมื่อ {new Date(request.created_at).toLocaleString("th-TH")}</small>
            </div>
            <span className={`status-pill status-${request.status}`}>{request.status}</span>
            <div className="row-actions">
              <button
                disabled={request.status === "approved"}
                type="button"
                onClick={() => onUpdateStatus(request, "approved")}
              >
                อนุมัติ
              </button>
              <button
                className="danger-button"
                disabled={request.status === "rejected"}
                type="button"
                onClick={() => onUpdateStatus(request, "rejected")}
              >
                ปฏิเสธ
              </button>
              <button type="button" onClick={() => onDelete(request)}>
                ลบคำขอ
              </button>
            </div>
          </article>
        )) : (
          <p className="empty-state">ยังไม่มีคำขอสมาชิกจาก LINE</p>
        )}
      </div>
    </div>
  );
}

function MembershipRequestSkeleton() {
  return (
    <article className="membership-card skeleton-row" aria-hidden="true">
      <div>
        <strong className="skeleton-line skeleton-title" />
        <span className="skeleton-line skeleton-meta" />
      </div>
      <span className="skeleton-pill" />
      <div className="row-actions">
        <span className="skeleton-pill" />
        <span className="skeleton-pill" />
      </div>
    </article>
  );
}

function StatSkeleton() {
  return (
    <div className="stat-card skeleton-card" aria-hidden="true">
      <span className="skeleton-line skeleton-short" />
      <strong className="skeleton-line skeleton-number" />
    </div>
  );
}

function VideoRowSkeleton() {
  return (
    <article className="video-row skeleton-row" aria-hidden="true">
      <div>
        <strong className="skeleton-line skeleton-title" />
        <span className="skeleton-line skeleton-meta" />
      </div>
      <div className="row-actions">
        <span className="skeleton-pill" />
        <span className="skeleton-pill" />
        <span className="skeleton-pill" />
      </div>
    </article>
  );
}

function Toast({ toast, onClose }) {
  if (!toast) return null;

  return (
    <div className={`toast-notice toast-${toast.type}`} role="status" aria-live="polite">
      <span className="toast-icon" aria-hidden="true">
        {toast.type === "success" ? "✓" : "!"}
      </span>
      <div>
        <strong>{toast.title}</strong>
        <p>{toast.message}</p>
      </div>
      <button type="button" aria-label="ปิดแจ้งเตือน" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function ConfirmDialog({ video, isOpen, title, message, confirmLabel = "ยืนยันลบ", onCancel, onConfirm }) {
  const shouldShow = Boolean(video) || isOpen;
  if (!shouldShow) return null;

  const dialogTitle = title || "ลบวิดีโอนี้ใช่ไหม?";
  const dialogMessage = message || `วิดีโอ “${video.title}” จะถูกนำออกจาก dashboard และผู้ใช้จะไม่เห็นรายการนี้อีก`;

  return (
    <div className="confirm-backdrop" role="presentation" onClick={onCancel}>
      <section
        aria-labelledby="delete-confirm-title"
        aria-modal="true"
        className="confirm-dialog"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
          <span className="confirm-icon" aria-hidden="true">!</span>
          <div className="confirm-copy">
            <p className="kicker">Confirm Delete</p>
          <h2 id="delete-confirm-title">{dialogTitle}</h2>
          <p>{dialogMessage}</p>
        </div>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>ยกเลิก</button>
          <button className="danger-confirm-button" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function WatchArea({ videos, isLoading, selectedVideoId, selectedVideo, onSelect }) {
  const visibleVideos = videos.filter((video) => video.is_active);
  const activeVideoId = selectedVideoId || visibleVideos[0]?.youtube_video_id || DEFAULT_VIDEO_ID;
  const showSkeleton = isLoading && !videos.length;

  return (
    <section className="watch-shell">
      <section className="player-section">
        {showSkeleton ? (
          <>
            <div className="video-frame skeleton-frame" aria-hidden="true">
              <span className="skeleton-play" />
            </div>
            <div className="video-library skeleton-library" aria-hidden="true">
              <div>
                <h2 className="skeleton-line skeleton-heading" />
                <p className="skeleton-line skeleton-copy" />
              </div>
              <div className="video-list">
                <span className="skeleton-chip" />
                <span className="skeleton-chip" />
                <span className="skeleton-chip" />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="video-frame">
              <iframe
                title="YouTube video player"
                src={buildEmbedUrl(activeVideoId)}
                allow="accelerometer; autoplay; encrypted-media; fullscreen; gyroscope; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                sandbox="allow-scripts allow-same-origin allow-presentation"
              />
              <div aria-hidden="true" className="youtube-link-shield youtube-title-shield" onContextMenu={(event) => event.preventDefault()} />
              <div aria-hidden="true" className="youtube-link-shield youtube-copy-shield" onContextMenu={(event) => event.preventDefault()} />
              <div aria-hidden="true" className="youtube-link-shield youtube-brand-shield" onContextMenu={(event) => event.preventDefault()} />
            </div>
            <div className="video-library">
              <div>
                <h2>{selectedVideo?.title || "วิดีโอ"}</h2>
                <p>{selectedVideo?.description || "เลือกวิดีโอที่ต้องการดูในหน้านี้"}</p>
              </div>
              <div className="video-list">
                {visibleVideos.map((video) => (
                  <button
                    className={video.youtube_video_id === activeVideoId ? "video-chip is-active" : "video-chip"}
                    key={video.id}
                    onClick={() => onSelect(video.youtube_video_id)}
                    type="button"
                  >
                    {video.title}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </section>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
