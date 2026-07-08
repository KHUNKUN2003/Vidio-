import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildEmbedUrl } from "../admin-utils.mjs";
import "./styles.css";

const DEFAULT_VIDEO_ID = "Xx_69DYLHt4";

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function useToastNotice() {
  const [toast, setToast] = useState(null);
  const hideTimerRef = useRef(null);
  const removeTimerRef = useRef(null);

  function clearToastTimers() {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
    }
    if (removeTimerRef.current) {
      window.clearTimeout(removeTimerRef.current);
    }
  }

  function dismissToast() {
    clearToastTimers();
    setToast((currentToast) => (currentToast ? { ...currentToast, isLeaving: true } : currentToast));
    removeTimerRef.current = window.setTimeout(() => setToast(null), 220);
  }

  function showToast(nextToast) {
    clearToastTimers();
    setToast({ id: Date.now(), isLeaving: false, ...nextToast });
    hideTimerRef.current = window.setTimeout(() => {
      setToast((currentToast) => (currentToast ? { ...currentToast, isLeaving: true } : currentToast));
    }, 3300);
    removeTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  }

  useEffect(() => clearToastTimers, []);

  return { toast, showToast, dismissToast };
}

function App() {
  const [session, setSession] = useState(() => {
    const saved = sessionStorage.getItem("course-session");
    if (!saved) return null;
    const savedSession = JSON.parse(saved);
    if (savedSession?.role === "user" && savedSession.provider !== "line") {
      sessionStorage.removeItem("course-session");
      return null;
    }
    return savedSession;
  });
  const [roleTab, setRoleTab] = useState("user");
  const [videos, setVideos] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0 });
  const [selectedVideoId, setSelectedVideoId] = useState(DEFAULT_VIDEO_ID);
  const [, setApiError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [authNotice, setAuthNotice] = useState(null);
  const [realtimeEvent, setRealtimeEvent] = useState(null);
  const [isLogoutConfirmOpen, setIsLogoutConfirmOpen] = useState(false);

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

  async function refreshData({ silent = false } = {}) {
    if (!silent) setIsLoading(true);
    try {
      setApiError("");
      const [videoResponse, dashboardResponse, playlistResponse] = await Promise.all([
        fetch("/api/videos"),
        fetch("/api/dashboard"),
        fetch("/api/playlists"),
      ]);

      if (!videoResponse.ok || !dashboardResponse.ok || !playlistResponse.ok) {
        throw new Error("เชื่อมต่อ PostgreSQL API ไม่สำเร็จ");
      }

      const videoData = await videoResponse.json();
      const dashboardData = await dashboardResponse.json();
      const playlistData = await playlistResponse.json();
      setVideos(videoData);
      setPlaylists(playlistData);
      setStats(dashboardData);
      if (!videoData.some((video) => video.youtube_video_id === selectedVideoId)) {
        setSelectedVideoId(videoData[0]?.youtube_video_id || "");
      }
    } catch (error) {
      setApiError(error.message);
      if (!silent) {
        setVideos([]);
        setPlaylists([]);
        setStats({ total: 0, active: 0, inactive: 0 });
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  }

  async function logout() {
    const currentSession = session;
    setIsLogoutConfirmOpen(false);
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
    if (!session) return undefined;

    refreshData();
    const intervalId = window.setInterval(() => refreshData({ silent: true }), 30000);
    return () => window.clearInterval(intervalId);
  }, [session, selectedVideoId]);

  useEffect(() => {
    if (!session || typeof EventSource === "undefined") return undefined;

    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      try {
        const realtimeData = JSON.parse(event.data);
        setRealtimeEvent({ id: Date.now(), type: realtimeData.type });
      } catch {
        // Ignore malformed realtime messages and keep the polling fallback alive.
      }
    };

    return () => events.close();
  }, [session]);

  useEffect(() => {
    if (!realtimeEvent) return;

    if (["videos", "playlists"].includes(realtimeEvent.type)) {
      refreshData({ silent: true });
    }
  }, [realtimeEvent]);

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

  useEffect(() => {
    if (!realtimeEvent || !["memberships", "sessions"].includes(realtimeEvent.type)) return;
    if (session?.provider !== "line" || !session.lineUserId) return;

    const params = new URLSearchParams({ lineUserId: session.lineUserId });
    fetch(`/api/auth/line/status?${params.toString()}`, {
      headers: authHeaders(session.token),
    })
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (ok && data.canWatch) return;

        setAuthNotice({
          title: "สิทธิ์ถูกเปลี่ยนแล้ว",
          message: "บัญชี LINE นี้ถูกปฏิเสธหรือไม่มีสิทธิ์ใช้งานแล้ว กรุณาติดต่อ admin",
          type: "error",
        });
        setRoleTab("user");
        saveSession(null);
      })
      .catch(() => {
        // Keep the current session if the realtime follow-up check hits a transient network issue.
      });
  }, [realtimeEvent, session]);

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
        <div className="topbar-brand">
          <img alt="" aria-hidden="true" src="/vidio-plus-icon.png" />
          <div>
          <p className="kicker">{session.role === "admin" ? "Admin" : session.lineName}</p>
            <h1>Vidio+</h1>
          </div>
        </div>
        <button className="ghost-button" type="button" onClick={() => setIsLogoutConfirmOpen(true)}>
          ออกจากระบบ
        </button>
      </header>

      <ConfirmDialog
        confirmLabel="ออกจากระบบ"
        isOpen={isLogoutConfirmOpen}
        kicker="Confirm Logout"
        message="ระบบจะปิดเซสชันบนอุปกรณ์นี้ และคุณจะต้องเข้าสู่ระบบใหม่เมื่อต้องการกลับมาดูคลิป"
        title="ออกจากระบบใช่ไหม?"
        onCancel={() => setIsLogoutConfirmOpen(false)}
        onConfirm={logout}
      />

      {session.role === "admin" && (
        <AdminDashboard
          stats={stats}
          videos={videos}
          playlists={playlists}
          isLoading={isLoading}
          token={session.token}
          onRefresh={refreshData}
          onSelect={setSelectedVideoId}
          onVideosReordered={setVideos}
          onPlaylistsUpdated={setPlaylists}
          realtimeEvent={realtimeEvent}
        />
      )}

      <WatchArea
        videos={videos}
        playlists={playlists}
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
  const [lineRequest, setLineRequest] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const { toast, showToast, dismissToast } = useToastNotice();

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

  async function submitLineLogin(event) {
    event.preventDefault();
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
      <Toast toast={toast} onClose={dismissToast} />
      <div className={roleTab === "admin" ? "auth-card" : "auth-card user-auth-card"}>
        <div className="auth-copy">
          <p className="kicker">Private YouTube Viewer</p>
          <h1>เข้าสู่ระบบเพื่อดูคลิป</h1>
          <p>พื้นที่ดูวิดีโอแบบเรียบง่ายสำหรับผู้ใช้ และมี dashboard สำหรับ admin จัดการคลิป</p>
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
            <form className="form-stack" onSubmit={submitLineLogin}>
              <button className="line-login-button" type="submit">Login with LINE</button>
            </form>
          </div>
        )}
        <button
          aria-label={roleTab === "admin" ? "กลับไปหน้า user" : "เข้าสู่หน้า admin"}
          className={roleTab === "admin" ? "admin-info-button is-active" : "admin-info-button"}
          onClick={() => onRoleChange(roleTab === "admin" ? "user" : "admin")}
          title={roleTab === "admin" ? "User login" : "Admin login"}
          type="button"
        >
          i
        </button>
      </div>
    </section>
  );
}

function AdminDashboard({ stats, videos, playlists, isLoading, token, realtimeEvent, onRefresh, onSelect, onVideosReordered, onPlaylistsUpdated }) {
  const emptyForm = { title: "", url: "", description: "", isActive: true };
  const emptyPlaylistForm = { title: "", description: "", videoIds: [] };
  const [activePanel, setActivePanel] = useState("videos");
  const [form, setForm] = useState(emptyForm);
  const [playlistForm, setPlaylistForm] = useState(emptyPlaylistForm);
  const [editingId, setEditingId] = useState(null);
  const [editingPlaylistId, setEditingPlaylistId] = useState(null);
  const [membershipRequests, setMembershipRequests] = useState([]);
  const [isMembershipLoading, setIsMembershipLoading] = useState(false);
  const { toast, showToast, dismissToast } = useToastNotice();
  const [pendingDeleteVideo, setPendingDeleteVideo] = useState(null);
  const [pendingDeleteMembership, setPendingDeleteMembership] = useState(null);
  const [pendingDeletePlaylist, setPendingDeletePlaylist] = useState(null);
  const [draggedVideoId, setDraggedVideoId] = useState(null);
  const [busyAction, setBusyAction] = useState("");
  const busyActionRef = useRef("");
  const isBusy = Boolean(busyAction);

  function startBusy(action) {
    if (busyActionRef.current) return false;
    busyActionRef.current = action;
    setBusyAction(action);
    return true;
  }

  function finishBusy(action) {
    if (busyActionRef.current !== action) return;
    busyActionRef.current = "";
    setBusyAction("");
  }

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
    const intervalId = window.setInterval(() => refreshMembershipRequests(true), 30000);
    return () => window.clearInterval(intervalId);
  }, [token]);

  useEffect(() => {
    if (realtimeEvent?.type === "memberships") {
      refreshMembershipRequests(true);
    }
  }, [realtimeEvent]);

  async function updateMembershipStatus(request, status) {
    const action = `membership-${status}-${request.id}`;
    if (!startBusy(action)) return;
    try {
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
    } finally {
      finishBusy(action);
    }
  }

  async function deleteMembershipRequest(request) {
    const action = `delete-membership-${request.id}`;
    if (!startBusy(action)) return;
    try {
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
    } finally {
      finishBusy(action);
    }
  }

  async function submitVideo(event) {
    event.preventDefault();
    const action = editingId ? `update-video-${editingId}` : "create-video";
    if (!startBusy(action)) return;
    try {
      const currentEditingId = editingId;
      const endpoint = currentEditingId ? `/api/videos/${currentEditingId}` : "/api/videos";
      const method = currentEditingId ? "PUT" : "POST";
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
        title: currentEditingId ? "อัปเดตสำเร็จ" : "อัปโหลดสำเร็จ",
        message: currentEditingId ? "บันทึกการแก้ไขวิดีโอเรียบร้อยแล้ว" : "เพิ่มคลิปใหม่เข้า dashboard เรียบร้อยแล้ว",
        type: "success",
      });
      await onRefresh();
    } finally {
      finishBusy(action);
    }
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
    const action = `delete-video-${video.id}`;
    if (!startBusy(action)) return;
    try {
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
    } finally {
      finishBusy(action);
    }
  }

  function togglePlaylistVideo(videoId) {
    const normalizedId = String(videoId);
    setPlaylistForm((currentForm) => ({
      ...currentForm,
      videoIds: currentForm.videoIds.includes(normalizedId)
        ? currentForm.videoIds.filter((id) => id !== normalizedId)
        : [...currentForm.videoIds, normalizedId],
    }));
  }

  function editPlaylist(playlist) {
    setEditingPlaylistId(playlist.id);
    setPlaylistForm({
      title: playlist.title,
      description: playlist.description || "",
      videoIds: playlist.videos.map((video) => String(video.id)),
    });
    setActivePanel("playlists");
  }

  async function submitPlaylist(event) {
    event.preventDefault();
    const action = editingPlaylistId ? `update-playlist-${editingPlaylistId}` : "create-playlist";
    if (!startBusy(action)) return;
    try {
      const currentEditingPlaylistId = editingPlaylistId;
      const endpoint = currentEditingPlaylistId ? `/api/playlists/${currentEditingPlaylistId}` : "/api/playlists";
      const method = currentEditingPlaylistId ? "PUT" : "POST";
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify(playlistForm),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        showToast({ title: "บันทึกเพลย์ลิสต์ไม่สำเร็จ", message: data?.error || "กรุณาลองใหม่อีกครั้ง", type: "error" });
        return;
      }

      onPlaylistsUpdated(data);
      setPlaylistForm(emptyPlaylistForm);
      setEditingPlaylistId(null);
      showToast({
        title: currentEditingPlaylistId ? "อัปเดตเพลย์ลิสต์แล้ว" : "สร้างเพลย์ลิสต์แล้ว",
        message: currentEditingPlaylistId ? "บันทึกการแก้ไขเพลย์ลิสต์เรียบร้อยแล้ว" : "เพิ่มเพลย์ลิสต์ใหม่เรียบร้อยแล้ว",
        type: "success",
      });
    } finally {
      finishBusy(action);
    }
  }

  async function deletePlaylist(playlist) {
    const action = `delete-playlist-${playlist.id}`;
    if (!startBusy(action)) return;
    try {
      const response = await fetch(`/api/playlists/${playlist.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        showToast({ title: "ลบเพลย์ลิสต์ไม่สำเร็จ", message: data?.error || "กรุณาลองใหม่อีกครั้ง", type: "error" });
        return;
      }

      onPlaylistsUpdated(playlists.filter((item) => item.id !== playlist.id));
      if (editingPlaylistId === playlist.id) {
        setEditingPlaylistId(null);
        setPlaylistForm(emptyPlaylistForm);
      }
      setPendingDeletePlaylist(null);
      showToast({ title: "ลบเพลย์ลิสต์แล้ว", message: `"${playlist.title}" ถูกนำออกจากรายการแล้ว`, type: "success" });
    } finally {
      finishBusy(action);
    }
  }

  async function reorderVideos(targetVideoId) {
    if (isBusy) return;
    if (!draggedVideoId || draggedVideoId === targetVideoId) return;

    const fromIndex = videos.findIndex((video) => video.id === draggedVideoId);
    const toIndex = videos.findIndex((video) => video.id === targetVideoId);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextVideos = [...videos];
    const [movedVideo] = nextVideos.splice(fromIndex, 1);
    nextVideos.splice(toIndex, 0, movedVideo);
    const action = "reorder-videos";
    if (!startBusy(action)) return;
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
      finishBusy(action);
    }
  }

  return (
    <section className="dashboard">
      <Toast toast={toast} onClose={dismissToast} />
      <ConfirmDialog
        isBusy={isBusy}
        video={pendingDeleteVideo}
        onCancel={() => !isBusy && setPendingDeleteVideo(null)}
        onConfirm={() => pendingDeleteVideo && deleteVideo(pendingDeleteVideo)}
      />
      <ConfirmDialog
        title="ลบคำขอนี้ใช่ไหม?"
        message={pendingDeleteMembership ? `คำขอของ ${pendingDeleteMembership.line_name} จะถูกนำออกจากรายการคำขอสมาชิก` : ""}
        confirmLabel="ยืนยันลบ"
        isBusy={isBusy}
        isOpen={Boolean(pendingDeleteMembership)}
        onCancel={() => !isBusy && setPendingDeleteMembership(null)}
        onConfirm={() => pendingDeleteMembership && deleteMembershipRequest(pendingDeleteMembership)}
      />
      <ConfirmDialog
        title="ลบเพลย์ลิสต์นี้ใช่ไหม?"
        message={pendingDeletePlaylist ? `เพลย์ลิสต์ "${pendingDeletePlaylist.title}" จะถูกนำออกจากรายการ แต่คลิปในเพลย์ลิสต์จะยังอยู่ในระบบ` : ""}
        confirmLabel="ยืนยันลบ"
        isBusy={isBusy}
        isOpen={Boolean(pendingDeletePlaylist)}
        onCancel={() => !isBusy && setPendingDeletePlaylist(null)}
        onConfirm={() => pendingDeletePlaylist && deletePlaylist(pendingDeletePlaylist)}
      />
      <div className="admin-panel-tabs">
        <button className={activePanel === "videos" ? "is-active" : ""} disabled={isBusy} type="button" onClick={() => setActivePanel("videos")}>
          วิดีโอ
        </button>
        <button className={activePanel === "playlists" ? "is-active" : ""} disabled={isBusy} type="button" onClick={() => setActivePanel("playlists")}>
          เพลย์ลิสต์
        </button>
        <button className={activePanel === "requests" ? "is-active" : ""} disabled={isBusy} type="button" onClick={() => setActivePanel("requests")}>
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
              <input disabled={isBusy} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
            </label>
            <label>
              YouTube URL
              <input disabled={isBusy} value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} required />
            </label>
            <label>
              คำอธิบาย
              <textarea disabled={isBusy} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </label>
            <div className="switch-row">
              <button
                aria-checked={form.isActive}
                aria-label={form.isActive ? "สาธารณะ" : "ไม่สาธารณะ"}
                className={form.isActive ? "toggle-switch is-on" : "toggle-switch"}
                disabled={isBusy}
                onClick={() => setForm({ ...form, isActive: !form.isActive })}
                role="switch"
                type="button"
              >
                <span />
              </button>
              <span>{form.isActive ? "สาธารณะ" : "ไม่สาธารณะ"}</span>
            </div>
            <div className="button-row">
              <button className="primary-button" disabled={isBusy} type="submit">
                <ActionLabel active={busyAction === (editingId ? `update-video-${editingId}` : "create-video")} loadingText="กำลังบันทึก">
                  {editingId ? "อัปเดต" : "เพิ่ม"}
                </ActionLabel>
              </button>
              {editingId && <button disabled={isBusy} type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }}>ยกเลิก</button>}
            </div>
          </form>

          <div className="table-panel">
            <div className="table-heading">
              <h2>รายการวิดีโอ</h2>
              <button disabled={isBusy} type="button" onClick={onRefresh}>รีเฟรช</button>
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
                  draggable={!isBusy}
                  key={video.id}
                  onDragEnd={() => setDraggedVideoId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDragStart={(event) => {
                    if (isBusy || event.target.closest(".row-actions")) {
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
                    disabled={isBusy}
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
                    <button disabled={isBusy} type="button" onClick={() => editVideo(video)}>แก้ไข</button>
                    <button className="danger-button" disabled={isBusy} type="button" onClick={() => setPendingDeleteVideo(video)}>
                      <ActionLabel active={busyAction === `delete-video-${video.id}`} loadingText="กำลังลบ">
                        ลบ
                      </ActionLabel>
                    </button>
                  </div>
                </article>
              ))}
              {!isLoading && !videos.length && <p className="empty-state">ยังไม่มีข้อมูลจาก PostgreSQL</p>}
            </div>
          </div>
        </>
      ) : activePanel === "playlists" ? (
        <PlaylistPanel
          busyAction={busyAction}
          form={playlistForm}
          editingId={editingPlaylistId}
          playlists={playlists}
          videos={videos}
          onCancel={() => { setEditingPlaylistId(null); setPlaylistForm(emptyPlaylistForm); }}
          onChange={setPlaylistForm}
          onDelete={setPendingDeletePlaylist}
          onEdit={editPlaylist}
          isBusy={isBusy}
          onSubmit={submitPlaylist}
          onToggleVideo={togglePlaylistVideo}
        />
      ) : (
        <MembershipRequestsPanel
          busyAction={busyAction}
          isLoading={isMembershipLoading}
          isBusy={isBusy}
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

function PlaylistPanel({ busyAction, form, editingId, isBusy, playlists, videos, onCancel, onChange, onDelete, onEdit, onSubmit, onToggleVideo }) {
  const saveAction = editingId ? `update-playlist-${editingId}` : "create-playlist";

  return (
    <div className="playlist-workspace">
      <form className="editor-panel playlist-editor" onSubmit={onSubmit}>
        <div>
          <h2>{editingId ? "แก้ไขเพลย์ลิสต์" : "เพิ่มเพลย์ลิสต์"}</h2>
          <p>จัดกลุ่มวิดีโอให้ผู้ใช้เลือกดูเป็นชุดได้ง่ายขึ้น</p>
        </div>
        <label>
          ชื่อเพลย์ลิสต์
          <input disabled={isBusy} value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} required />
        </label>
        <label>
          คำอธิบาย
          <textarea disabled={isBusy} value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} />
        </label>
        <div className="playlist-video-picker">
          <span>วิดีโอในเพลย์ลิสต์</span>
          {videos.length ? videos.map((video) => (
            <label className="playlist-check" key={video.id}>
              <input
                checked={form.videoIds.includes(String(video.id))}
                disabled={isBusy}
                onChange={() => onToggleVideo(video.id)}
                type="checkbox"
              />
              <span className="playlist-checkmark" aria-hidden="true" />
              <span>
                <strong>{video.title}</strong>
                <small>{video.youtube_video_id}</small>
              </span>
            </label>
          )) : (
            <p className="empty-state">ยังไม่มีวิดีโอให้เลือก</p>
          )}
        </div>
        <div className="button-row">
          <button className="primary-button" disabled={isBusy} type="submit">
            <ActionLabel active={busyAction === saveAction} loadingText="กำลังบันทึก">
              {editingId ? "อัปเดตเพลย์ลิสต์" : "เพิ่มเพลย์ลิสต์"}
            </ActionLabel>
          </button>
          {editingId && <button disabled={isBusy} type="button" onClick={onCancel}>ยกเลิก</button>}
        </div>
      </form>

      <div className="table-panel playlist-panel">
        <div className="table-heading">
          <div>
            <h2>รายการเพลย์ลิสต์</h2>
            <p>{playlists.length ? `มีเพลย์ลิสต์ทั้งหมด ${playlists.length} รายการ` : "ยังไม่มีเพลย์ลิสต์"}</p>
          </div>
        </div>
        <div className="playlist-list">
          {playlists.length ? playlists.map((playlist) => (
            <article className="playlist-card" key={playlist.id}>
              <div>
                <strong>{playlist.title}</strong>
                <span>{playlist.description || "ไม่มีคำอธิบาย"}</span>
                <small>{playlist.videos.length} วิดีโอ</small>
              </div>
              <div className="playlist-video-preview">
                {playlist.videos.slice(0, 4).map((video) => (
                  <span key={video.id}>{video.title}</span>
                ))}
                {playlist.videos.length > 4 && <span>+{playlist.videos.length - 4}</span>}
              </div>
              <div className="row-actions">
                <button disabled={isBusy} type="button" onClick={() => onEdit(playlist)}>แก้ไข</button>
                <button className="danger-button" disabled={isBusy} type="button" onClick={() => onDelete(playlist)}>
                  <ActionLabel active={busyAction === `delete-playlist-${playlist.id}`} loadingText="กำลังลบ">
                    ลบ
                  </ActionLabel>
                </button>
              </div>
            </article>
          )) : (
            <p className="empty-state">สร้างเพลย์ลิสต์แรกเพื่อจัดกลุ่มวิดีโอสำหรับผู้ใช้</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MembershipRequestsPanel({ busyAction, isLoading, isBusy, requests, onRefresh, onUpdateStatus, onDelete }) {
  const pendingCount = requests.filter((request) => request.status === "pending").length;

  return (
    <div className="table-panel membership-panel">
      <div className="table-heading">
        <div>
          <h2>คำขอสมาชิก</h2>
          <p>{pendingCount ? `มีคำขอรออนุมัติ ${pendingCount} รายการ` : "ยังไม่มีคำขอที่ต้องรออนุมัติ"}</p>
        </div>
        <button disabled={isBusy} type="button" onClick={onRefresh}>รีเฟรช</button>
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
                disabled={isBusy || request.status === "approved"}
                type="button"
                onClick={() => onUpdateStatus(request, "approved")}
              >
                <ActionLabel active={busyAction === `membership-approved-${request.id}`} loadingText="กำลังอนุมัติ">
                  อนุมัติ
                </ActionLabel>
              </button>
              <button
                className="danger-button"
                disabled={isBusy || request.status === "rejected"}
                type="button"
                onClick={() => onUpdateStatus(request, "rejected")}
              >
                <ActionLabel active={busyAction === `membership-rejected-${request.id}`} loadingText="กำลังปฏิเสธ">
                  ปฏิเสธ
                </ActionLabel>
              </button>
              <button disabled={isBusy} type="button" onClick={() => onDelete(request)}>
                <ActionLabel active={busyAction === `delete-membership-${request.id}`} loadingText="กำลังลบ">
                  ลบคำขอ
                </ActionLabel>
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
    <div className={`toast-notice toast-${toast.type}${toast.isLeaving ? " is-leaving" : ""}`} role="status" aria-live="polite">
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

function ActionLabel({ active, loadingText, children }) {
  if (!active) return children;

  return (
    <span className="action-label">
      <span className="button-loader" aria-hidden="true" />
      <span>{loadingText}</span>
    </span>
  );
}

function ConfirmDialog({ video, isOpen, title, message, kicker = "Confirm Delete", confirmLabel = "ยืนยันลบ", isBusy = false, onCancel, onConfirm }) {
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
            <p className="kicker">{kicker}</p>
          <h2 id="delete-confirm-title">{dialogTitle}</h2>
          <p>{dialogMessage}</p>
        </div>
        <div className="confirm-actions">
          <button disabled={isBusy} type="button" onClick={onCancel}>ยกเลิก</button>
          <button className="danger-confirm-button" disabled={isBusy} type="button" onClick={onConfirm}>
            <ActionLabel active={isBusy} loadingText="กำลังทำรายการ">
              {confirmLabel}
            </ActionLabel>
          </button>
        </div>
      </section>
    </div>
  );
}

function WatchArea({ videos, playlists, isLoading, selectedVideoId, selectedVideo, onSelect }) {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("all");
  const activePlaylist = playlists.find((playlist) => String(playlist.id) === selectedPlaylistId);
  const visibleVideos = (activePlaylist ? activePlaylist.videos : videos).filter((video) => video.is_active);
  const activeVideoId = visibleVideos.some((video) => video.youtube_video_id === selectedVideoId)
    ? selectedVideoId
    : visibleVideos[0]?.youtube_video_id || "";
  const activeVideo = visibleVideos.find((video) => video.youtube_video_id === activeVideoId);
  const showSkeleton = isLoading && !videos.length;
  const hasVisibleVideo = Boolean(activeVideoId && activeVideo);

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
        ) : !hasVisibleVideo ? (
          <>
            <div className="video-frame empty-video-frame">
              <div>
                <h2>ยังไม่มีคลิปให้ดู</h2>
                <p>เมื่อ admin เพิ่มหรือเปิดวิดีโอให้ user เห็น คลิปจะแสดงตรงนี้</p>
              </div>
            </div>
            <div className="video-library">
              <div>
                <h2>ไม่มีวิดีโอ</h2>
                <p>ยังไม่มีคลิปที่เปิดให้รับชมในตอนนี้</p>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="video-frame" onContextMenu={(event) => event.preventDefault()}>
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
              <div aria-hidden="true" className="youtube-link-shield youtube-more-options-shield" onContextMenu={(event) => event.preventDefault()} />
              <div aria-hidden="true" className="youtube-link-shield youtube-brand-shield" onContextMenu={(event) => event.preventDefault()} />
            </div>
            <div className="video-library">
              <div>
                <h2>{activeVideo?.title || "วิดีโอ"}</h2>
                <p>{activeVideo?.description || "เลือกวิดีโอที่ต้องการดูในหน้านี้"}</p>
              </div>
              <div className="playlist-selector" aria-label="เลือกเพลย์ลิสต์">
                <button
                  className={selectedPlaylistId === "all" ? "is-active" : ""}
                  onClick={() => setSelectedPlaylistId("all")}
                  type="button"
                >
                  ทั้งหมด
                </button>
                {playlists.map((playlist) => (
                  <button
                    className={String(playlist.id) === selectedPlaylistId ? "is-active" : ""}
                    key={playlist.id}
                    onClick={() => setSelectedPlaylistId(String(playlist.id))}
                    type="button"
                  >
                    {playlist.title}
                  </button>
                ))}
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
