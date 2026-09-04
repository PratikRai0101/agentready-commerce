"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { ProductMatch } from "@agentready/catalog";
import type { AuditEvent } from "@agentready/audit";
import type { CommerceEnvelope } from "@agentready/domain";
import type { IntentField } from "./IntentPanel";

type QuoteResult = {
  envelope: CommerceEnvelope;
  digest: string;
  signature: string;
  state: string;
  approvalEventId?: string;
};

function formatINR(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN")}`;
}

const VERIFIED_STATES = ["PAID_VERIFIED", "FULFILMENT_PENDING", "FULFILLED", "FULFILMENT_FAILED", "COMPENSATION_PENDING", "REFUNDED"];

function fulfilmentLabel(orderState: string): string {
  switch (orderState) {
    case "PAID_VERIFIED":
      return "Paid — awaiting fulfilment";
    case "FULFILMENT_PENDING":
      return "Fulfilment in progress";
    case "FULFILLED":
      return "Fulfilled";
    case "FULFILMENT_FAILED":
      return "Fulfilment failed";
    case "COMPENSATION_PENDING":
      return "Refund in progress";
    case "REFUNDED":
      return "Refunded";
    default:
      return orderState;
  }
}

const ledgerStyles = `
  .ledger, .ledger-grid, .ledger-main, .ledger-hero-wrap, .ledger-section, .ledger-hero { min-width:0; }
  .ledger { background: var(--bg); min-height:100%; }
  .ledger-topbar { display:flex; align-items:center; gap:10px; padding:11px 14px; background:#fff; border-bottom:1px solid var(--border); position:sticky; top:0; z-index:5; }
  .ledger-brand { display:flex; align-items:center; gap:8px; }
  .ledger-brand-name { font-family:var(--font-head); font-weight:700; font-size:14px; letter-spacing:-0.02em; }
  .ledger-brand-sub { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); }
  .ledger-order-pill { margin-left:8px; font-size:11px; padding:4px 10px; border-radius:999px; background:var(--bg); border:1px solid var(--border); color:var(--text-soft); font-weight:500; }
  .ledger-order-pill.is-approved { background: var(--good-soft); border-color: var(--good); color: var(--good); }
  .ledger-mock-badge { margin-left:auto; font-size:10px; padding:3px 8px; border-radius:999px; background: var(--warn-soft); color: var(--warn); border:1px solid var(--warn); font-weight:600; letter-spacing:0.06em; text-transform:uppercase; }
  .ledger-grid.desktop { display:grid; grid-template-columns: 320px minmax(0,1fr); min-height:0; align-items: start; gap:0; }
  .ledger-chat { background:#fff; border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; align-self: start; height: fit-content; max-height: calc(78vh - 12px); overflow: auto; position: sticky; top: 0; }
  .ledger-chat-head { display:flex; align-items:center; justify-content:space-between; padding:12px 12px 8px; border-bottom:1px solid var(--border-subtle); }
  .ledger-chat-head h2 { font-family:var(--font-head); font-size:13px; font-weight:700; letter-spacing:-0.01em; }
  .ledger-chat-status { font-size:10px; padding:2px 6px; border-radius:999px; background:var(--bg); border:1px solid var(--border); color:var(--text-muted); }
  .ledger-chat-collapsed { display:flex; flex-direction:column; gap:6px; margin:10px; padding:10px 12px; background: var(--bg); border:1px dashed var(--border); border-radius:10px; cursor:pointer; text-align:left; }
  .ledger-chat-collapsed-summary { font-size:11px; font-weight:500; color:var(--text-soft); }
  .ledger-chat-collapsed-cta { font-size:10px; font-weight:600; color:var(--accent-deep); }
  .ledger-chat-collapse-btn { margin:6px 10px 10px; padding:6px; background:none; border:none; font-size:11px; color:var(--text-muted); cursor:pointer; }
  .ledger-chat-log { padding:10px 12px; display:flex; flex-direction:column; gap:8px; max-height: 260px; overflow:auto; }
  .ledger-msg { max-width:88%; padding:8px 10px; border-radius:12px; font-size:12px; line-height:1.5; }
  .ledger-msg.user { align-self:flex-end; background: linear-gradient(180deg, var(--accent-soft) 0%, #f0d5c8 100%); border-bottom-right-radius:4px; color:var(--text); }
  .ledger-msg.agent { align-self:flex-start; background:#fff; border:1px solid var(--border); box-shadow:var(--shadow-sm); border-bottom-left-radius:4px; }
  .ledger-quick { display:flex; gap:6px; flex-wrap:wrap; padding:0 12px 10px; }
  .ledger-quick-btn { padding:6px 10px; border-radius:999px; background:var(--accent-soft); color:var(--accent-deep); border:none; font-size:11px; font-weight:500; cursor:pointer; }
  .ledger-composer { display:flex; gap:6px; padding:8px 10px; background:#fff; border-top:1px solid var(--border); margin-top:auto; }
  .ledger-composer-input { flex:1; padding:8px 10px; border:1px solid var(--border); border-radius:8px; font-size:12px; background:var(--bg); outline:none; }
  .ledger-composer-input:focus { border-color: var(--accent); }
  .ledger-composer-send { padding:8px 12px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; }
  .ledger-chat-foot { padding:6px 10px; font-size:10px; color:var(--text-muted); text-align:center; background:#fff; border-top:1px dashed var(--border); }
  .ledger-main { padding:14px 14px 16px; display:flex; flex-direction:column; gap:14px; min-width:0; overflow:hidden; }
  .ledger-stack { display:flex; flex-direction:column; min-height:100%; position:relative; min-width:0; }
  .ledger-stack .ledger-main { padding-bottom: 0; }
  .ledger-progress { display:flex; gap:6px; flex-wrap:wrap; }
  .ledger-step { display:inline-flex; align-items:center; gap:5px; padding:5px 10px; border-radius: 999px; font-size:11px; font-weight:500; background:#fff; border:1px solid var(--border); color:var(--text-muted); transition: all 0.2s; }
  .ledger-step.active { background: var(--accent); color:#fff; border-color:var(--accent); box-shadow: 0 2px 8px rgba(200,92,59,0.25); }
  .ledger-step.done { background: var(--good-soft); border-color: var(--good); color: var(--good); }
  .ledger-step-num { font-weight:700; font-size:10px; width:16px; height:16px; display:inline-grid; place-items:center; border-radius:50%; background: rgba(0,0,0,0.06); }
  .ledger-step.active .ledger-step-num { background: rgba(255,255,255,0.2); }
  .ledger-hero-wrap { background:#fff; border:1px solid var(--border); border-radius:14px; padding:14px; box-shadow:var(--shadow-sm); overflow:hidden; }
  .ledger-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
  .ledger-section-head h3 { font-family:var(--font-head); font-size:14px; font-weight:700; letter-spacing:-0.02em; }
  .ledger-section-sub { font-size:11px; color:var(--text-muted); }
  .ledger-hero { border:1px solid var(--border); border-radius:12px; overflow:hidden; background:#fff; box-shadow:var(--shadow-sm); transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s; }
  .ledger-hero:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); border-color: var(--accent); }
  .ledger-hero.selected { border-color:var(--accent); box-shadow:0 6px 20px rgba(200,92,59,0.14); }
  .ledger-hero-badge { padding:7px 12px; font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; background: linear-gradient(90deg, var(--accent-soft) 0%, #f0d5c8 100%); color:var(--accent-deep); border-bottom:1px solid var(--border-subtle); }
  .ledger-hero.selected .ledger-hero-badge { background: linear-gradient(90deg, var(--accent) 0%, #d46a4a 100%); color:#fff; }
  .ledger-hero-media { position:relative; aspect-ratio: 16/9; background: #EDE4D8; overflow:hidden; }
  .ledger-hero-img { width:100%; height:100%; object-fit: cover; display:block; }
  .ledger-hero-gradient { position:absolute; inset:0; background: linear-gradient(180deg, transparent 60%, rgba(32,26,21,0.04) 100%); pointer-events:none; }
  .ledger-hero-body { padding:12px 14px 14px; display:flex; flex-direction:column; gap:8px; min-width:0; }
  .ledger-hero-title-row { display:flex; justify-content:space-between; gap:8px; align-items:baseline; min-width:0; }
  .variant-desktop .ledger-hero { display: grid; grid-template-columns: 340px minmax(0, 1fr); grid-template-rows: auto 1fr; }
  .variant-desktop .ledger-hero-badge { grid-column: 1 / -1; grid-row: 1; }
  .variant-desktop .ledger-hero-media { grid-column: 1; grid-row: 2; aspect-ratio: auto; height: 100%; min-height: 240px; }
  .variant-desktop .ledger-hero-body { grid-column: 2; grid-row: 2; }
  @media (max-width: 920px) { .variant-desktop .ledger-hero { grid-template-columns: 1fr; } .variant-desktop .ledger-hero-media { aspect-ratio: 16/9; min-height: auto; height: auto; } }
  .ledger-hero-name { font-family:var(--font-head); font-size:17px; font-weight:700; letter-spacing:-0.02em; line-height:1.2; }
  .ledger-hero-price { font-size:17px; font-weight:800; letter-spacing:-0.03em; color: var(--text); }
  .ledger-hero-score { font-size:12px; font-weight:600; color:var(--accent-deep); }
  .ledger-hero-score span { font-weight:400; color:var(--text-muted); font-size:11px; }
  .ledger-hero-desc { font-size:12px; color:var(--text-soft); line-height:1.5; }
  .ledger-hero-reason { font-size:12px; color:var(--text-soft); }
  .ledger-hero-compromise { font-size:11px; color:var(--warn); }
  .ledger-hero-actions { display:flex; gap:8px; margin-top:6px; }
  .ledger-btn-ghost { padding:9px 14px; background:#fff; border:1px solid var(--border); border-radius:8px; font-size:12px; font-weight:500; cursor:pointer; }
  .ledger-btn-ghost:hover { border-color: var(--accent); }
  .ledger-btn-ghost.sm { padding:7px 10px; font-size:11px; }
  .ledger-btn-primary { flex:1; padding:10px 14px; background: var(--accent); color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; transition: background 0.15s, transform 0.15s, box-shadow 0.15s; }
  .ledger-btn-primary:hover { background: var(--accent-deep); transform: translateY(-0.5px); box-shadow: 0 4px 12px rgba(200,92,59,0.2); }
  .ledger-btn-primary:active { transform:none; }
  .ledger-btn-primary.is-selected { background: var(--good); }
  .ledger-btn-primary.is-selected:hover { background: #356a43; }
  .ledger-btn-primary.sm { padding:7px 10px; font-size:11px; }
  .ledger-btn-primary.disabled { background: var(--text-muted); opacity:0.6; cursor:not-allowed; transform:none; box-shadow:none; }
  .ledger-alts { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; margin-top:12px; }
  .variant-mobile .ledger-alts { grid-template-columns: 1fr; }
  .ledger-alt { display:flex; gap:10px; padding:10px; border:1px solid var(--border); border-radius:10px; background:#fff; box-shadow:var(--shadow-sm); transition: all 0.2s; min-width:0; overflow:hidden; }
  .ledger-alt:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: var(--shadow-md); }
  .ledger-alt.selected { border-color: var(--accent); box-shadow: 0 4px 14px rgba(200,92,59,0.12); }
  .ledger-alt-img { width:84px; height:84px; object-fit: cover; border-radius:8px; background:#EDE4D8; flex-shrink:0; }
  .ledger-alt-body { flex:1; display:flex; flex-direction:column; gap:4px; min-width:0; overflow:hidden; }
  .ledger-alt-head { display:flex; justify-content:space-between; gap:6px; align-items:baseline; min-width:0; }
  .ledger-alt-name { font-family:var(--font-head); font-size:12px; font-weight:700; line-height:1.2; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; min-width:0; flex:1; }
  .ledger-alt-price { font-size:12px; font-weight:700; white-space:nowrap; flex-shrink:0; }
  .ledger-alt-score { font-size:11px; font-weight:600; color:var(--accent-deep); overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ledger-alt-reason { font-size:11px; color:var(--text-soft); line-height:1.3; overflow:hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .ledger-alt-compromise { font-size:10px; color:var(--warn); }
  .ledger-alt-actions { display:flex; gap:6px; margin-top:auto; }
  .ledger-alt-badge { display:inline-flex; align-self: flex-start; font-size:9px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; padding:3px 6px; border-radius:999px; background: var(--bg); border:1px solid var(--border); color:var(--text-muted); margin-bottom: 2px; flex-shrink:0; }
  .ledger-alt.selected .ledger-alt-badge { background: var(--accent); color:#fff; border-color: var(--accent); }
  .ledger-note { font-size:10px; color:var(--text-muted); margin-top:8px; font-style:italic; }
  .ledger-section-muted { background:#fff; border:1px solid var(--border); border-radius:12px; padding:12px; box-shadow:var(--shadow-sm); }
  .ledger-label { font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-soft); margin:0 0 6px; }
  .ledger-chips { display:flex; flex-wrap:wrap; gap:6px; }
  .ledger-chip { display:inline-flex; align-items:center; gap:4px; padding:6px 10px; border-radius:999px; font-size:11px; font-weight:600; box-shadow:var(--shadow-sm); transition: transform 0.15s; }
  .ledger-chip:hover { transform: translateY(-0.5px); }
  .ledger-chip.requirement { background:var(--text); color:#fff; border:1px solid var(--text); }
  .ledger-chip.preference { background:var(--bg-raised); color:var(--text); border:1px solid var(--border); }
  .ledger-chip.unresolved { background:var(--warn-soft); color:var(--warn); border:1px solid var(--warn); }
  .ledger-chip.editing { background:#fff; border:1px solid var(--accent); padding:2px; }
  .ledger-chip-label { background:none; border:none; color:inherit; font:inherit; cursor:pointer; padding:0; }
  .ledger-chip-x { background:transparent; border:none; color:inherit; opacity:0.7; cursor:pointer; font-size:12px; line-height:1; padding:0 1px; }
  .ledger-chip-x:hover { opacity:1; }
  .ledger-chip-input { border:none; background:transparent; font-size:11px; font-family:var(--font-body); outline:none; color:var(--text); }
  .ledger-hint { font-size:10px; color:var(--text-muted); margin-top:8px; }
  .ledger-loading { display:flex; align-items:center; gap:8px; padding:8px 0; }
  .ledger-dots { display:inline-flex; gap:4px; }
  .ledger-dot { width:5px; height:5px; border-radius:50%; background:var(--accent); animation: ledgerPulse 1.8s infinite ease-in-out; }
  .ledger-dot:nth-child(2){animation-delay:0.2s} .ledger-dot:nth-child(3){animation-delay:0.4s}
  @keyframes ledgerPulse { 0%,80%,100%{opacity:0.28; transform:scale(0.85)} 40%{opacity:1; transform:scale(1)} }
  @media (prefers-reduced-motion: reduce){ .ledger-dot{animation:none; opacity:0.6} }
  .ledger-loading-text { font-size:11px; color:var(--text-muted); }
  .ledger-approval { background:#fff; border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:12px; padding:14px; box-shadow:var(--shadow-sm); }
  .ledger-approval.approved { border-left-color:var(--good); background: linear-gradient(180deg, #fff 0%, #f8fdf9 100%); }
  .ledger-approval-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .ledger-approval-head h3 { font-family:var(--font-head); font-size:15px; font-weight:700; letter-spacing:-0.02em; }
  .ledger-approval-pill { padding:4px 8px; border-radius:999px; font-size:10px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; }
  .ledger-approval-pill.accent { background:var(--accent-soft); color:var(--accent-deep); }
  .ledger-approval-pill.good { background:var(--good-soft); color:var(--good); }
  .ledger-approval-pill.muted { background:var(--bg); border:1px solid var(--border); color:var(--text-muted); }
  .ledger-approval-sub { font-size:11px; color:var(--text-soft); margin:4px 0 10px; line-height:1.5; }
  .ledger-approval-grid { display:grid; grid-template-columns: 88px 1fr; gap:4px 10px; font-size:12px; }
  .ledger-approval-grid .k { color:var(--text-soft); font-size:11px; }
  .ledger-approval-grid .v { overflow-wrap:anywhere; font-weight:500; }
  .ledger-approval-grid .v.total { font-weight:800; font-size:15px; letter-spacing:-0.03em; }
  .ledger-approve-btn { width:100%; margin-top:12px; padding:11px 14px; background: linear-gradient(180deg, var(--accent) 0%, var(--accent-deep) 100%); color:#fff; border:none; border-radius:10px; font-size:13px; font-weight:700; cursor:pointer; transition: transform 0.15s, box-shadow 0.15s; box-shadow: 0 2px 10px rgba(200,92,59,0.2); }
  .ledger-approve-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(200,92,59,0.28); }
  .ledger-approve-btn:disabled { opacity:0.6; cursor:not-allowed; transform:none; box-shadow:none; background: var(--text-muted); }
  .ledger-approved-row { display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .ledger-approved-check { font-size:12px; font-weight:700; color:var(--good); }
  .ledger-approval-foot { font-size:10px; color:var(--text-muted); margin-top:8px; }
  .ledger-empty { padding:12px; background:var(--bg); border:1px dashed var(--border); border-radius:8px; font-size:11px; color:var(--text-muted); text-align:center; }
  .ledger-resource { background: linear-gradient(180deg, #fdfbf8 0%, #fff 100%); border:1px solid var(--border); border-radius:12px; padding:14px; }
  .ledger-resource-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .ledger-resource-head h3 { font-family:var(--font-head); font-size:13px; font-weight:700; }
  .ledger-resource-pill { padding:3px 7px; border-radius:999px; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; }
  .ledger-resource-pill.mock { background:var(--bg); border:1px solid var(--border); color:var(--text-muted); }
  .ledger-resource-sub { font-size:11px; color:var(--text-muted); margin:4px 0 10px; }
  .ledger-resource-summary { display:flex; gap:10px; align-items:center; padding:10px 12px; background:#fff; border:1px solid var(--border); border-radius:10px; }
  .ledger-resource-icon { width:32px; height:32px; display:grid; place-items:center; border-radius:8px; background: var(--accent-soft); color: var(--accent-deep); font-size:14px; flex-shrink:0; }
  .ledger-resource-title { font-size:12px; font-weight:600; }
  .ledger-resource-meta { font-size:11px; color:var(--text-muted); }
  .ledger-details { margin-top:10px; border-top:1px solid var(--border-subtle); padding-top:8px; }
  .ledger-details summary { font-size:11px; font-weight:600; color:var(--accent-deep); cursor:pointer; list-style:none; text-align:center; }
  .ledger-details summary::-webkit-details-marker { display:none; }
  .ledger-details-body { padding-top:8px; display:flex; flex-direction:column; gap:6px; }
  .ledger-details-body.mono { font-family: var(--mono); font-size:11px; color: var(--text-soft); }
  .ledger-kv { display:flex; justify-content:space-between; gap:8px; font-size:11px; }
  .ledger-kv span:first-child { color:var(--text-muted); }
  .ledger-box { background:#fff; border:1px solid var(--border); border-radius:12px; padding:14px; box-shadow:var(--shadow-sm); }
  .ledger-box h3 { font-family:var(--font-head); font-size:13px; font-weight:700; margin-bottom:8px; letter-spacing:-0.01em; }
  .ledger-box-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .ledger-box-head h3 { margin-bottom:0; }
  .ledger-link-btn { background:none; border:none; font-size:11px; font-weight:600; color:var(--accent-deep); cursor:pointer; }
  .ledger-pay-status { font-size:12px; font-weight:600; color:var(--text-soft); margin-bottom:8px; }
  .ledger-hint { font-size:10px; color:var(--text-muted); margin-top:6px; }
  .ledger-timeline { display:flex; flex-direction:column; gap:1px; }
  .ledger-timeline-row { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border-subtle); font-size:11px; }
  .ledger-timeline-row:last-child{border-bottom:none}
  .ledger-timeline-dot { width:7px; height:7px; border-radius:50%; background: var(--accent); flex-shrink:0; }
  .ledger-timeline-row:last-child .ledger-timeline-dot { background: var(--good); }
  .ledger-timeline-event { color:var(--text); flex:1; }
  .ledger-timeline-actor { font-size:10px; padding:2px 6px; border-radius:999px; background:var(--bg); border:1px solid var(--border); color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; }
  .ledger-audit-expand { margin-top:10px; padding:8px 10px; background:var(--bg); border-radius:8px; }
  .ledger-mono { font-family:var(--mono); font-size:11px; color:var(--text-soft); overflow-wrap:anywhere; }
  .ledger-tech { background:#fff; border:1px solid var(--border); border-radius:12px; padding:10px 14px; }
  .ledger-tech-toggle { width:100%; display:flex; justify-content:space-between; align-items:center; background:none; border:none; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-soft); cursor:pointer; }
  .ledger-tech-chevron { font-size:10px; transition: transform 0.2s; }
  .ledger-tech-body { margin-top:12px; display:flex; flex-direction:column; gap:12px; }
  .ledger-tech-title { font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-soft); margin-bottom:6px; }
  .ledger-pre { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px; font-family:var(--mono); font-size:10px; line-height:1.5; overflow:auto; white-space:pre-wrap; word-break:break-word; }
  .ledger-provider { display:flex; justify-content:space-between; gap:8px; align-items:center; padding:8px 10px; background:var(--bg); border-radius:8px; font-size:11px; }
  .ledger-provider .pill { font-family:var(--mono); font-size:10px; font-weight:700; padding:2px 6px; border-radius:999px; }
  .ledger-provider .pill.mock { background:#fff; border:1px solid var(--border); color:var(--text-muted); }
  .ledger-provider .pill.disabled { background:var(--warn-soft); color:var(--warn); }
  .ledger-tech-list { margin:0; padding-left:16px; font-size:11px; color:var(--text-soft); line-height:1.5; }
  .ledger-tech-note { font-size:10px; color:var(--text-muted); font-style:italic; }
  .ledger-sticky { position:sticky; bottom:0; left:0; right:0; background: rgba(255,255,255,0.96); backdrop-filter: blur(8px); border-top:1px solid var(--border); padding:10px 12px calc(10px + env(safe-area-inset-bottom)); display:flex; flex-direction:column; gap:6px; box-shadow: 0 -4px 12px rgba(32,26,21,0.06); }
  .variant-mobile .ledger-sticky { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); width: 390px; max-width: calc(100vw - 20px); z-index: 30; border:1px solid var(--border); border-radius: 12px; padding:10px 12px; box-shadow: 0 8px 24px rgba(32,26,21,0.14); }
  .variant-mobile .ledger-stack { padding-bottom: 96px; }
  .ledger-sticky-inner { display:flex; align-items:center; gap:10px; }
  .ledger-sticky-total { font-size:12px; font-weight:700; }
  .ledger-sticky .ledger-btn-primary { flex:1; padding:10px 14px; font-size:13px; }
  .ledger-sticky-note { font-size:10px; color:var(--text-muted); text-align:center; }
`;

type MachineSpendInfo = {
  mock: boolean;
  paymentIdentifier: string;
  txHash: string;
  network: string;
  amount: string;
};

type Props = {
  variant: "desktop" | "mobile";
  // Chat
  messages: { role: "user" | "agent"; text: string }[];
  questions: string[];
  quickReplies: string[];
  input: string;
  onInputChange: (v: string) => void;
  onSend: (text: string) => void;
  busy: boolean;
  // Ledger
  intent: IntentField[];
  intentVersion: number;
  editingChip: string | null;
  onStartEdit: (k: string) => void;
  onSaveEdit: (k: string, v: string) => void;
  onCancelEdit: () => void;
  onRemove: (k: string) => void;
  showLoading: boolean;
  pendingUpdatedReview: boolean;
  onPendingReviewSeen: () => void;
  matches: ProductMatch[] | null;
  fitScores: Record<string, { fitScore: number; note: string }> | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  quote: QuoteResult | null;
  orderState: string;
  approved: boolean;
  onApprove: () => void;
  onUnapprove: () => void;
  // Audit & spend
  timeline: AuditEvent[];
  machineSpend: MachineSpendInfo | null;
  // Payment
  paymentIds: { orderId?: string; paymentId?: string; signature?: string } | null;
  receipt?: {
    totalMinor: number;
    currency: string;
    externalOrderId?: string;
    externalPaymentId?: string;
    signature?: string;
  } | null;
  isMock: boolean;
  onInitiate: () => void;
  onMockCapture: () => void;
  onFulfil: () => void;
  onCompensate: () => void;
  // Tech
  techExpanded: boolean;
  onToggleTech: () => void;
  // Chat collapse (mobile)
  chatExpanded: boolean;
  onToggleChat: () => void;
  auditExpanded: boolean;
  onToggleAudit: () => void;
  disablePayments?: boolean;
};

export function DecisionLedger(props: Props) {
  const {
    variant,
    messages,
    questions,
    quickReplies,
    input,
    onInputChange,
    onSend,
    busy,
    intent,
    intentVersion,
    editingChip,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onRemove,
    showLoading,
    pendingUpdatedReview,
    onPendingReviewSeen,
    matches,
    fitScores,
    selectedId,
    onSelect,
    quote,
    orderState,
    approved,
    onApprove,
    onUnapprove,
    timeline,
    machineSpend,
    paymentIds,
    receipt = null,
    isMock,
    onInitiate,
    onMockCapture,
    onFulfil,
    onCompensate,
    techExpanded,
    onToggleTech,
    chatExpanded,
    onToggleChat,
    auditExpanded,
    onToggleAudit,
    disablePayments = false,
  } = props;

  const requirements = intent.filter((f) => f.kind === "requirement");
  const preferences = intent.filter((f) => f.kind === "preference");
  const unresolved = intent.filter((f) => f.kind === "unresolved");

  const isRebuilding = showLoading;
  const activeStep = (() => {
    if (orderState === "DRAFT" || orderState === "CLARIFYING") return 1;
    if (orderState === "SHORTLISTED" || orderState === "QUOTED" || orderState === "REAPPROVAL_REQUIRED") return 2;
    if (orderState === "AWAITING_APPROVAL") return 3;
    if (orderState === "APPROVED") return 4;
    if (["PAYMENT_PENDING", "PAID_VERIFIED", "FULFILMENT_PENDING", "FULFILLED"].includes(orderState)) return 5;
    return 1;
  })();

  const selectedMatch = matches?.find((m) => m.product.productId === selectedId) ?? null;
  const sortedMatches = matches ? [...matches].sort((a, b) => b.scoreNormalized - a.scoreNormalized) : [];
  const heroMatch = sortedMatches[0] ?? null;
  const altMatches = sortedMatches.slice(1, 3);
  const isHeroSelected = heroMatch ? selectedId === heroMatch.product.productId : false;

  // Humanize audit like main page, but keep as same order state source
  const visibleAudit = timeline.slice(-6);
  const quoteDigest = quote?.digest ?? "";
  const totalMinor = quote?.envelope.totalMinor ?? (selectedMatch ? selectedMatch.product.priceMinor + 4900 : 0);

  // Settled receipt snapshot wins over the active quote/paymentIds so that
  // follow-up chat (which may clear the quote) cannot erase the receipt.
  const receiptOrderId = receipt?.externalOrderId ?? paymentIds?.orderId;
  const receiptPaymentId = receipt?.externalPaymentId ?? paymentIds?.paymentId;
  const receiptSignature = receipt?.signature ?? paymentIds?.signature;
  const receiptTotalSuffix = receipt
    ? ` · ${formatINR(receipt.totalMinor)} ${receipt.currency}`
    : quote
      ? ` · ${formatINR(quote.envelope.totalMinor)} ${quote.envelope.currency}`
      : "";

  const reviewRef = useRef<HTMLDivElement>(null);
  const [reviewInView, setReviewInView] = useState(false);

  useEffect(() => {
    if (variant !== "mobile") return;
    const card = reviewRef.current;
    if (!card) return;
    // In main storefront, ledger is not inside proto-frame-body but inside content-col/page
    // Use viewport as root if proto-frame not present
    const frame = (card.closest(".proto-frame-body") as HTMLElement | null) ?? null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && entry.isIntersecting) setReviewInView(true);
        else setReviewInView(false);
      },
      { root: frame, threshold: 0.35 }
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [variant, selectedMatch, approved, quote]);

  useEffect(() => {
    if (pendingUpdatedReview && !isRebuilding && reviewInView && quote && orderState === "AWAITING_APPROVAL") {
      onPendingReviewSeen();
    }
  }, [pendingUpdatedReview, isRebuilding, reviewInView, quote, orderState, onPendingReviewSeen]);

  useEffect(() => {
    if (variant === "desktop" && pendingUpdatedReview && !isRebuilding && quote && orderState === "AWAITING_APPROVAL") {
      onPendingReviewSeen();
    }
  }, [variant, pendingUpdatedReview, isRebuilding, quote, orderState, onPendingReviewSeen]);

  const scrollToReview = () => {
    const card = reviewRef.current;
    const frame = card?.closest(".proto-frame-body") as HTMLElement | null;
    if (card && frame) {
      frame.scrollTo({ top: card.offsetTop - 12, behavior: "smooth" });
    } else if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      // Fallback for main storefront (no proto-frame)
      document.getElementById("order-review")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, questions]);

  const ChatPanel = (
    <section className="ledger-chat" aria-label="Conversation">
      <div className="ledger-chat-head">
        <h2>Assistant</h2>
        <span className="ledger-chat-status">Deterministic · mock</span>
      </div>
      {variant === "mobile" && !chatExpanded ? (
        <button type="button" className="ledger-chat-collapsed" onClick={onToggleChat} aria-expanded="false">
          <span className="ledger-chat-collapsed-summary">UK 9 · Road · Wide · Max cushioning → 3 ranked</span>
          <span className="ledger-chat-collapsed-cta">Show conversation ▼</span>
        </button>
      ) : (
        <>
          <div className="ledger-chat-log" ref={chatRef} role="log" aria-live="polite">
            {messages.map((m, i) => (
              <div key={i} className={`ledger-msg ${m.role}`}>
                {m.text}
              </div>
            ))}
            {questions.length > 0 && (
              <div className="ledger-msg agent">{questions.length === 1 ? questions[0] : questions.join(" · ")}</div>
            )}
            {quickReplies.length > 0 && (
              <div className="ledger-quick" role="group" aria-label="Quick replies">
                {quickReplies.map((r) => (
                  <button key={r} type="button" className="ledger-quick-btn" onClick={() => onSend(r)} disabled={busy}>
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <div className="ledger-composer" role="form" aria-label="Message input">
        <input
          className="ledger-composer-input"
          type="text"
          value={input}
          placeholder={messages.length === 0 ? "I need black shoes under ₹5,000." : "Ask about a shoe, compare, or refine…"}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSend(input || "I need black shoes under ₹5,000.");
          }}
          aria-label="Message the assistant"
        />
        <button className="ledger-composer-send" type="button" onClick={() => onSend(input || "I need black shoes under ₹5,000.")} disabled={busy}>
          Send
        </button>
      </div>
      <div className="ledger-chat-foot">Mock composer — no payment submission</div>
      {variant === "mobile" && chatExpanded && (
        <button type="button" className="ledger-chat-collapse-btn" onClick={onToggleChat}>
          Hide conversation ▲
        </button>
      )}
    </section>
  );

  const Recommendations = (
    <div className="ledger-section ledger-hero-wrap">
      <div className="ledger-section-head">
        <h3>Recommendation</h3>
        <span className="ledger-section-sub">Model advisory only · 1 dominant + 2 alternatives</span>
      </div>
      {!matches ? (
        <div className="ledger-empty">
          {questions.length > 0 ? "Answer the question above to get your shortlist." : "Tell me how you run and I’ll shortlist honest options."}
        </div>
      ) : heroMatch ? (
        <>
          <article className={`ledger-hero ${isHeroSelected ? "selected" : ""}`}>
            <div className="ledger-hero-badge">{heroMatch.role === "bestOverall" ? "Recommended for you" : heroMatch.role === "cheaperAlternative" ? "Cheaper alternative" : "Trade-off choice"}</div>
            <div className="ledger-hero-media">
              {heroMatch.product.image ? (
                <Image src={heroMatch.product.image} alt={heroMatch.product.name} width={640} height={400} className="ledger-hero-img" unoptimized />
              ) : (
                <div className="ledger-hero-img" style={{ background: "#EDE4D8", display: "grid", placeItems: "center" }}>
                  {heroMatch.product.name}
                </div>
              )}
              <div className="ledger-hero-gradient" aria-hidden="true" />
            </div>
            <div className="ledger-hero-body">
              <div className="ledger-hero-title-row">
                <h4 className="ledger-hero-name">{heroMatch.product.name}</h4>
                <span className="ledger-hero-price">{formatINR(heroMatch.product.priceMinor)}</span>
              </div>
              <div className="ledger-hero-score">
                {fitScores?.[heroMatch.product.productId] ? `${fitScores[heroMatch.product.productId]!.fitScore}% fit` : `${heroMatch.scoreNormalized}/100`} · <span>{heroMatch.product.deliveryLeadDays}d · {heroMatch.product.fit} · {heroMatch.product.cushioning}</span>
              </div>
              <p className="ledger-hero-desc">{heroMatch.product.description}</p>
              {heroMatch.matchedPreferences.slice(0, 1).map((r) => (
                <div key={r} className="ledger-hero-reason">
                  • {r}
                </div>
              ))}
              {heroMatch.compromises.slice(0, 1).map((c) => (
                <div key={c} className="ledger-hero-compromise">
                  — {c}
                </div>
              ))}
              <div className="ledger-hero-actions">
                <button type="button" className="ledger-btn-ghost" onClick={() => onSend(`why ${heroMatch.product.name}?`)} disabled={busy}>
                  Why this one?
                </button>
                <button
                  type="button"
                  className={`ledger-btn-primary ${isHeroSelected ? "is-selected" : ""}`}
                  onClick={() => onSelect(heroMatch.product.productId)}
                  disabled={busy || isRebuilding}
                  aria-pressed={isHeroSelected}
                >
                  {isHeroSelected ? "Selected" : "Select"} · {formatINR(heroMatch.product.priceMinor)}
                </button>
              </div>
            </div>
          </article>
          <div className="ledger-alts">
            {altMatches.map((m) => {
              const sel = selectedId === m.product.productId;
              return (
                <article key={m.product.productId} className={`ledger-alt ${sel ? "selected" : ""}`}>
                  {m.product.image ? (
                    <Image src={m.product.image} alt={m.product.name} width={240} height={150} className="ledger-alt-img" unoptimized />
                  ) : (
                    <div className="ledger-alt-img" style={{ background: "#EDE4D8" }} />
                  )}
                  <div className="ledger-alt-body">
                    <span className="ledger-alt-badge">{m.role === "cheaperAlternative" ? "Cheaper alternative" : m.role === "tradeoffChoice" ? "Trade-off choice" : "Option"}</span>
                    <div className="ledger-alt-head">
                      <span className="ledger-alt-name">{m.product.name}</span>
                      <span className="ledger-alt-price">{formatINR(m.product.priceMinor)}</span>
                    </div>
                    <div className="ledger-alt-score">
                      {fitScores?.[m.product.productId] ? `${fitScores[m.product.productId]!.fitScore}% fit` : `${m.scoreNormalized}/100`} · {m.product.deliveryLeadDays}d
                    </div>
                    {m.matchedPreferences.slice(0, 1).map((r) => (
                      <div key={r} className="ledger-alt-reason">
                        • {r}
                      </div>
                    ))}
                    {m.compromises.slice(0, 1).map((c) => (
                      <div key={c} className="ledger-alt-compromise">
                        — {c}
                      </div>
                    ))}
                    <div className="ledger-alt-actions">
                      <button type="button" className="ledger-btn-ghost sm" onClick={() => onSend(`why ${m.product.name}?`)} disabled={busy}>
                        Why?
                      </button>
                      <button type="button" className={`ledger-btn-primary sm ${sel ? "is-selected" : ""}`} onClick={() => onSelect(m.product.productId)} disabled={busy || isRebuilding}>
                        {sel ? "Selected" : "Select"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="ledger-note">Grounded in catalog only · stock checked at quote time</div>
        </>
      ) : null}
    </div>
  );

  const Constraints = (
    <div className="ledger-section ledger-section-muted">
      <div className="ledger-section-head">
        <h3>What I understood</h3>
        <span className="ledger-section-sub">Editable · v{intentVersion}</span>
      </div>
      {isRebuilding ? (
        <div className="ledger-loading" role="status" aria-live="polite">
          <span className="ledger-dots" aria-hidden="true">
            <span className="ledger-dot" />
            <span className="ledger-dot" />
            <span className="ledger-dot" />
          </span>
          <span className="ledger-loading-text">Re-ranking…</span>
        </div>
      ) : null}
      {requirements.length > 0 && (
        <>
          <div className="ledger-label">Requirements</div>
          <div className="ledger-chips">
            {requirements.map((f) =>
              editingChip === f.key ? (
                <span key={f.key} className="ledger-chip editing">
                  <input
                    autoFocus
                    defaultValue={f.label}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSaveEdit(f.key, (e.target as HTMLInputElement).value);
                      if (e.key === "Escape") onCancelEdit();
                    }}
                    onBlur={(e) => onSaveEdit(f.key, e.currentTarget.value)}
                    aria-label={`Edit ${f.label}`}
                    className="ledger-chip-input"
                    style={{ width: Math.max(56, f.label.length * 7 + 24) }}
                  />
                </span>
              ) : (
                <span key={f.key} className="ledger-chip requirement">
                  <button type="button" className="ledger-chip-label" onClick={() => onStartEdit(f.key)} aria-label={`Edit ${f.label}`} disabled={busy}>
                    {f.label}
                  </button>
                  <button type="button" className="ledger-chip-x" onClick={() => onRemove(f.key)} aria-label={`Remove ${f.label}`} disabled={busy}>
                    ×
                  </button>
                </span>
              )
            )}
          </div>
        </>
      )}
      {preferences.length > 0 && (
        <>
          <div className="ledger-label" style={{ marginTop: 10 }}>
            Preferences
          </div>
          <div className="ledger-chips">
            {preferences.map((f) =>
              editingChip === f.key ? (
                <span key={f.key} className="ledger-chip editing">
                  <input
                    autoFocus
                    defaultValue={f.label}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSaveEdit(f.key, (e.target as HTMLInputElement).value);
                      if (e.key === "Escape") onCancelEdit();
                    }}
                    onBlur={(e) => onSaveEdit(f.key, e.currentTarget.value)}
                    aria-label={`Edit ${f.label}`}
                    className="ledger-chip-input"
                    style={{ width: Math.max(56, f.label.length * 7 + 24) }}
                  />
                </span>
              ) : (
                <span key={f.key} className="ledger-chip preference">
                  <button type="button" className="ledger-chip-label" onClick={() => onStartEdit(f.key)} aria-label={`Edit ${f.label}`} disabled={busy}>
                    {f.label}
                  </button>
                  <button type="button" className="ledger-chip-x" onClick={() => onRemove(f.key)} aria-label={`Remove ${f.label}`} disabled={busy}>
                    ×
                  </button>
                </span>
              )
            )}
          </div>
        </>
      )}
      {unresolved.length > 0 && (
        <>
          <div className="ledger-label ledger-label-warn">Needs your input</div>
          <div className="ledger-chips">
            {unresolved.map((f) => (
              <span key={f.key} className="ledger-chip unresolved">
                {f.label}
              </span>
            ))}
          </div>
        </>
      )}
      <div className="ledger-hint">Tap to edit · × to remove · changes re-rank (real API)</div>
    </div>
  );

  const selectedEnvelopeItem = quote?.envelope.items[0];
  const ApprovalCard = (
    <div ref={reviewRef} id="order-review" className={`ledger-approval ${approved ? "approved" : ""}`}>
      <div className="ledger-approval-head">
        <h3>{approved ? "Order review — approved" : "Order review"}</h3>
        <span className={`ledger-approval-pill ${orderState === "APPROVED" ? "good" : orderState === "AWAITING_APPROVAL" || orderState === "REAPPROVAL_REQUIRED" ? "accent" : "muted"}`}>
          {orderState === "APPROVED" ? "✓ Approved" : orderState === "AWAITING_APPROVAL" || orderState === "REAPPROVAL_REQUIRED" ? "Awaiting approval" : "Select a shoe"}
        </span>
      </div>
      <div className="ledger-approval-sub">Approval locks these exact terms. Any material change requires re-approval. Hashes in technical details.</div>
      {quote && selectedEnvelopeItem ? (
        <>
          <div className="ledger-approval-grid">
            <span className="k">Item</span>
            <span className="v">
              {quote.envelope.items.map((it) => it.sku).join(", ")} · {selectedEnvelopeItem.variant?.size}
            </span>
            <span className="k">Qty</span>
            <span className="v">{selectedEnvelopeItem.quantity}</span>
            <span className="k">Subtotal</span>
            <span className="v">{formatINR(quote.envelope.subtotalMinor)}</span>
            <span className="k">Shipping</span>
            <span className="v">{formatINR(quote.envelope.shippingMinor)}</span>
            <span className="k">Total</span>
            <span className="v total">{formatINR(quote.envelope.totalMinor)}</span>
            <span className="k">Expires</span>
            <span className="v mono">{new Date(quote.envelope.expiresAt).toLocaleTimeString()}</span>
            <span className="k">Return</span>
            <span className="v">Returnable within 14 days, unworn</span>
          </div>
          {!approved ? (
            <button className="ledger-approve-btn" type="button" onClick={onApprove} disabled={busy || isRebuilding} aria-busy={isRebuilding}>
              {isRebuilding ? "Review updated order" : "Approve this exact order"}
            </button>
          ) : (
            <div className="ledger-approved-row">
              <span className="ledger-approved-check">✓ Approved — exact terms bound</span>
              <button type="button" className="ledger-btn-ghost" onClick={onUnapprove} disabled={busy}>
                Undo
              </button>
            </div>
          )}
          <div className="ledger-approval-foot">No Razorpay order until approved — payment stays disabled until approved.</div>
        </>
      ) : (
        <div className="ledger-empty">Select a recommendation to generate the exact order.</div>
      )}
    </div>
  );

  const AgentResource = (
    <div className="ledger-resource">
      <div className="ledger-resource-head">
        <h3>Agent resource</h3>
        <span className="ledger-resource-pill mock">Mock — no funds moved</span>
      </div>
      <div className="ledger-resource-sub">Separate from Razorpay payment · synthetic · Devnet disabled</div>
      <div className="ledger-resource-summary">
        <span className="ledger-resource-icon" aria-hidden="true">
          ◈
        </span>
        <div>
          <div className="ledger-resource-title">RunVista Premium Fit-Scoring API via x402 v2</div>
          <div className="ledger-resource-meta">
            {machineSpend ? `${machineSpend.amount} USDC · ${machineSpend.network} · ${machineSpend.paymentIdentifier.slice(0, 8)}…` : "0.02 USDC · used to disambiguate fit · not the retail invoice"}
          </div>
        </div>
      </div>
      <details className="ledger-details">
        <summary>Show resource evidence</summary>
        <div className="ledger-details-body mono">
          {machineSpend ? (
            <>
              <div className="ledger-kv">
                <span>Payment ID</span>
                <span>{machineSpend.paymentIdentifier}</span>
              </div>
              <div className="ledger-kv">
                <span>Tx</span>
                <span>{machineSpend.txHash.slice(0, 8)}…</span>
              </div>
              <div className="ledger-kv">
                <span>Amount</span>
                <span>{machineSpend.amount} USDC</span>
              </div>
            </>
          ) : (
            <>
              <div className="ledger-kv">
                <span>Payment ID</span>
                <span>x402_mock_7f3a…c9e2</span>
              </div>
              <div className="ledger-kv">
                <span>Tx</span>
                <span>mock_4k9…9f21 (explorer disabled)</span>
              </div>
            </>
          )}
          <div className="ledger-kv">
            <span>Request digest</span>
            <span>sha256:8b1a…3f</span>
          </div>
        </div>
      </details>
    </div>
  );

  const Audit = (
    <div className="ledger-box">
      <div className="ledger-box-head">
        <h3>Audit history</h3>
        <span className="ledger-box-count">
          {timeline.length} events · {orderState}
        </span>
        <button type="button" className="ledger-link-btn" onClick={onToggleAudit} aria-expanded={auditExpanded}>
          {auditExpanded ? "Hide details" : "Show details"}
        </button>
      </div>
      <div className="ledger-timeline">
        {timeline.slice(-6).map((e) => (
          <div key={e.eventId} className="ledger-timeline-row">
            <span className="ledger-timeline-dot" aria-hidden="true" />
            <span className="ledger-timeline-event">{e.summary.length > 60 ? e.summary.slice(0, 60) + "…" : e.summary}</span>
            <span className="ledger-timeline-actor">{e.actor}</span>
          </div>
        ))}
        {timeline.length === 0 && <div className="ledger-mono">No events yet.</div>}
      </div>
      {auditExpanded && (
        <div className="ledger-audit-expand">
          <div className="ledger-mono">IDs · hashes · timestamps and developer notes are collapsed by default. Full envelope digest and signatures appear in Technical details below.</div>
        </div>
      )}
    </div>
  );

  const Tech = (
    <div className="ledger-tech">
      <button type="button" className="ledger-tech-toggle" onClick={onToggleTech} aria-expanded={techExpanded}>
        Technical details <span className="ledger-tech-chevron">{techExpanded ? "▲" : "▼"}</span>
      </button>
      {techExpanded && (
        <div className="ledger-tech-body">
          <div className="ledger-tech-section">
            <div className="ledger-tech-title">IDs, hashes, timestamps</div>
            {quote ? (
              <>
                <div className="ledger-mono">orderId: {quote.envelope.logicalOrderId} · mandateId: {quote.envelope.mandateId}</div>
                <div className="ledger-mono">digest: {quote.digest}</div>
                <div className="ledger-mono">signature: {quote.signature.slice(0, 16)}…</div>
                <div className="ledger-mono">issuedAt: {quote.envelope.issuedAt} · expiresAt: {quote.envelope.expiresAt}</div>
              </>
            ) : (
              <div className="ledger-mono">No quote yet — hashes appear after selection.</div>
            )}
          </div>
          <div className="ledger-tech-section">
            <div className="ledger-tech-title">Providers &amp; modes</div>
            <div className="ledger-provider">
              <span>Razorpay</span>
              <span className="muted">rzp_test · capture verified</span>
              <span className="pill mock">MOCK</span>
            </div>
            <div className="ledger-provider">
              <span>x402 / Solana</span>
              <span className="muted">Mock settlement — no funds moved</span>
              <span className="pill mock">MOCK</span>
            </div>
            <div className="ledger-provider">
              <span>LLM</span>
              <span className="muted">deterministic fallback</span>
              <span className="pill disabled">disabled</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <style>{ledgerStyles}</style>
      <div className={`ledger variant-${variant}`}>
        <div className="ledger-topbar">
        <div className="ledger-brand">
          <svg width="22" height="22" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <rect x="2" y="18" width="4" height="8" rx="1" fill="var(--accent)" />
            <rect x="8" y="12" width="4" height="14" rx="1" fill="var(--accent)" />
            <rect x="14" y="6" width="4" height="20" rx="1" fill="var(--accent)" />
            <rect x="20" y="2" width="4" height="24" rx="1" fill="var(--accent)" opacity="0.35" />
          </svg>
          <span className="ledger-brand-name">RunVista</span>
          <span className="ledger-brand-sub">Sports</span>
        </div>
        <span className={`ledger-order-pill ${orderState === "APPROVED" ? "is-approved" : ""}`}>{orderState === "APPROVED" ? "● Approved" : orderState === "AWAITING_APPROVAL" || orderState === "REAPPROVAL_REQUIRED" ? "○ Awaiting approval" : orderState === "QUOTED" ? "○ Quoted" : `○ ${orderState}`}</span>
        <span className="ledger-mock-badge">Mock</span>
      </div>
      {variant === "desktop" ? (
        <div className="ledger-grid desktop">
          {ChatPanel}
          <section className="ledger-main" aria-label="Decision ledger">
            <div className="ledger-progress" role="navigation" aria-label="Order progress">
              {["Preferences", "Recommendation", "Review", "Approval", "Payment"].map((label, i) => (
                <span key={label} className={`ledger-step ${i + 1 === activeStep ? "active" : i + 1 < activeStep ? "done" : ""}`}>
                  <span className="ledger-step-num">{i + 1}</span> {label}
                </span>
              ))}
            </div>
            {Recommendations}
            {Constraints}
            {ApprovalCard}
            {AgentResource}
            <div className="ledger-box ledger-pay">
              <h3>Payment</h3>
              {disablePayments ? (
                <>
                  <div className="ledger-pay-status">{orderState === "APPROVED" ? "Approved — ready for Razorpay" : "Awaiting approval — payment blocked"}</div>
                  <button className="ledger-btn-primary disabled" type="button" disabled title="Prototype — no payment submission">
                    Pay with Razorpay
                  </button>
                  <div className="ledger-hint">Disabled in prototype — preserves Razorpay flow.</div>
                </>
              ) : orderState === "APPROVED" ? (
                <>
                  <div className="ledger-pay-status">Approved — ready for Razorpay</div>
                  {!paymentIds?.orderId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onInitiate} disabled={busy}>
                      Pay with Razorpay
                    </button>
                  ) : isMock && !paymentIds.paymentId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onMockCapture} disabled={busy}>
                      Complete test payment
                    </button>
                  ) : paymentIds?.paymentId ? (
                    <div className="ledger-mono">Payment {paymentIds.paymentId.slice(0, 8)}… verified</div>
                  ) : (
                    <button className="ledger-btn-primary" type="button" onClick={onInitiate} disabled={busy}>
                      Pay with Razorpay
                    </button>
                  )}
                </>
              ) : orderState === "PAYMENT_PENDING" ? (
                <>
                  <div className="ledger-pay-status">{isMock ? "Payment pending — mock order created" : "Payment pending — awaiting Razorpay capture"}</div>
                  {isMock && paymentIds?.orderId && !paymentIds.paymentId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onMockCapture} disabled={busy}>
                      Complete test payment
                    </button>
                  ) : !isMock && !paymentIds?.paymentId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onInitiate} disabled={busy}>
                      Reopen Razorpay Checkout
                    </button>
                  ) : paymentIds?.paymentId ? (
                    <div className="ledger-mono">Payment {paymentIds.paymentId.slice(0, 8)}… verifying</div>
                  ) : (
                    <div className="ledger-hint">Awaiting payment capture.</div>
                  )}
                </>
              ) : VERIFIED_STATES.includes(orderState) ? (
                <>
                  <div className="ledger-pay-status">Payment verified{isMock ? " — mock, no charge" : ""}</div>
                  <div className="ledger-mono">
                    {receiptPaymentId ? `Payment ${receiptPaymentId.slice(0, 8)}…` : "Payment recorded"}
                    {receiptOrderId ? ` · order ${receiptOrderId.slice(0, 8)}…` : ""}
                    {receiptSignature ? " · signature verified" : ""}
                    {receiptTotalSuffix}
                  </div>
                  <div className="ledger-hint">Fulfilment: {fulfilmentLabel(orderState)}</div>
                </>
              ) : (
                <>
                  <div className="ledger-pay-status">Awaiting approval — payment blocked</div>
                  <button className="ledger-btn-primary disabled" type="button" disabled>
                    Pay with Razorpay
                  </button>
                </>
              )}
            </div>
            {Audit}
            {Tech}
          </section>
        </div>
      ) : (
        <div className="ledger-stack">
          <section className="ledger-main" aria-label="Decision ledger">
            <div className="ledger-progress" role="navigation" aria-label="Order progress">
              {["Preferences", "Recommendation", "Review", "Approval", "Payment"].map((label, i) => (
                <span key={label} className={`ledger-step ${i + 1 === activeStep ? "active" : i + 1 < activeStep ? "done" : ""}`}>
                  <span className="ledger-step-num">{i + 1}</span> {label}
                </span>
              ))}
            </div>
            {Recommendations}
            {Constraints}
            {ApprovalCard}
            {AgentResource}
            {Audit}
            {ChatPanel}
            <div className="ledger-box ledger-pay">
              <h3>Payment</h3>
              {disablePayments ? (
                <>
                  <div className="ledger-pay-status">{orderState === "APPROVED" ? "Approved — ready for Razorpay" : "Awaiting approval"}</div>
                  <button className="ledger-btn-primary disabled" type="button" disabled>
                    Pay with Razorpay
                  </button>
                  <div className="ledger-hint">Disabled — approval required.</div>
                </>
              ) : orderState === "APPROVED" ? (
                <>
                  <div className="ledger-pay-status">Approved — ready for Razorpay</div>
                  {!paymentIds?.orderId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onInitiate} disabled={busy}>
                      Pay with Razorpay
                    </button>
                  ) : isMock && !paymentIds.paymentId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onMockCapture} disabled={busy}>
                      Complete test payment
                    </button>
                  ) : paymentIds?.paymentId ? (
                    <div className="ledger-mono">Payment {paymentIds.paymentId.slice(0, 8)}… verified</div>
                  ) : null}
                </>
              ) : orderState === "PAYMENT_PENDING" ? (
                <>
                  <div className="ledger-pay-status">{isMock ? "Payment pending — mock order created" : "Payment pending — awaiting Razorpay capture"}</div>
                  {isMock && paymentIds?.orderId && !paymentIds.paymentId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onMockCapture} disabled={busy}>
                      Complete test payment
                    </button>
                  ) : !isMock && !paymentIds?.paymentId ? (
                    <button className="ledger-btn-primary" type="button" onClick={onInitiate} disabled={busy}>
                      Reopen Razorpay Checkout
                    </button>
                  ) : paymentIds?.paymentId ? (
                    <div className="ledger-mono">Payment {paymentIds.paymentId.slice(0, 8)}… verifying</div>
                  ) : (
                    <div className="ledger-hint">Awaiting payment capture.</div>
                  )}
                </>
              ) : VERIFIED_STATES.includes(orderState) ? (
                <>
                  <div className="ledger-pay-status">Payment verified{isMock ? " — mock, no charge" : ""}</div>
                  <div className="ledger-mono">
                    {receiptPaymentId ? `Payment ${receiptPaymentId.slice(0, 8)}…` : "Payment recorded"}
                    {receiptOrderId ? ` · order ${receiptOrderId.slice(0, 8)}…` : ""}
                    {receiptSignature ? " · signature verified" : ""}
                    {receiptTotalSuffix}
                  </div>
                  <div className="ledger-hint">Fulfilment: {fulfilmentLabel(orderState)}</div>
                </>
              ) : (
                <>
                  <div className="ledger-pay-status">Awaiting approval — payment blocked</div>
                  <button className="ledger-btn-primary disabled" type="button" disabled>
                    Pay with Razorpay
                  </button>
                </>
              )}
            </div>
            {Tech}
            <div style={{ height: 72 }} aria-hidden="true" />
          </section>
          <div className="ledger-sticky">
            <div className="ledger-sticky-inner">
              <span className="ledger-sticky-total">
                {quote ? formatINR(quote.envelope.totalMinor) : heroMatch ? formatINR(heroMatch.product.priceMinor + 4900) : selectedMatch ? formatINR(selectedMatch.product.priceMinor + 4900) : "—"} ·{" "}
                {isRebuilding ? "Updating order…" : pendingUpdatedReview ? "Review updated order" : orderState === "APPROVED" ? "Approved" : reviewInView ? "Ready to approve" : "Review needed"}
              </span>
              {isRebuilding ? (
                <button className="ledger-btn-primary" type="button" disabled aria-busy="true" title="Rebuilding quote — approval disabled">
                  Review updated order
                </button>
              ) : pendingUpdatedReview ? (
                !quote ? (
                  <button className="ledger-btn-primary" type="button" onClick={scrollToReview} title="Select a product to generate updated order">
                    Review updated order
                  </button>
                ) : !reviewInView ? (
                  <button className="ledger-btn-primary" type="button" onClick={scrollToReview} title="Updated terms below — scroll to review">
                    Review updated order
                  </button>
                ) : (
                  <button className="ledger-btn-primary" type="button" onClick={onApprove} disabled={!quote || busy} title="Updated terms displayed — approve now">
                    Approve this exact order
                  </button>
                )
              ) : approved ? (
                <button className="ledger-btn-primary is-selected" type="button" onClick={onUnapprove} title="Undo mock approval">
                  Approved ✓
                </button>
              ) : !reviewInView ? (
                <button className="ledger-btn-primary" type="button" onClick={scrollToReview} title="Scroll to exact terms">
                  Review order
                </button>
              ) : (
                <button className="ledger-btn-primary" type="button" onClick={onApprove} disabled={!quote || busy} title="Mock approve exact order">
                  Approve this exact order
                </button>
              )}
            </div>
            <div className="ledger-sticky-note">
              {isRebuilding ? "Rebuilding quote — approval disabled until updated terms are displayed" : pendingUpdatedReview ? (!quote ? "Select a product to review updated order" : !reviewInView ? "Updated terms below — review before approving" : "Updated terms ready — approve below") : reviewInView ? "Mock · no charge · hashes in Technical details" : "Tap to review exact terms before approval"}
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
