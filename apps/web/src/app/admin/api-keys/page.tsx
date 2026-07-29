"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { KeyManager, type LicenseKeySummary } from "@/components/key-manager";
import { apiBase } from "@/lib/api-base";

export default function AdminApiKeysPage() {
  const [keys, setKeys] = useState<LicenseKeySummary[]>([]);
  const [generatedKey, setGeneratedKey] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const apiUrl = apiBase();

  const getHeaders = () => ({
    "Content-Type": "application/json",
  });

  const fetchKeys = async () => {
    setError(undefined);
    try {
      const response = await fetch(`${apiUrl}/v1/keys`, { headers: getHeaders(), credentials: "include" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || "Gagal memuat key.");
      setKeys(payload.keys ?? []);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Gagal memuat key.");
    }
  };

  const handleGenerate = async () => {
    setLoading(true);
    setError(undefined);
    setGeneratedKey(undefined);
    try {
      const response = await fetch(`${apiUrl}/v1/keys`, {
        method: "POST",
        headers: getHeaders(),
        credentials: "include",
        body: JSON.stringify({ deviceLimit: 2 }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || "Tidak dapat membuat key.");
      setGeneratedKey(payload.rawKey);
      await fetchKeys();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Tidak dapat membuat key.");
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`${apiUrl}/v1/keys/${keyId}/revoke`, {
        method: "POST",
        headers: getHeaders(),
        credentials: "include",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || "Tidak dapat mencabut key.");
      await fetchKeys();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Tidak dapat mencabut key.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  return (
    <AppShell role="admin" eyebrow="Admin" title="API Keys">
      {error && <section className="panel error-panel"><p>{error}</p></section>}
      <KeyManager
        keys={keys}
        generatedKey={generatedKey}
        loading={loading}
        error={error}
        onGenerate={handleGenerate}
        onRevoke={handleRevoke}
      />
    </AppShell>
  );
}
