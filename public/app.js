const CELO_HEX = "0xa4ec";
const CELO_ID = 42220;
const NGNM = "0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const naira = new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v) => naira.format(Number(v || 0));
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

const state = { account: null, chainId: null, quote: null, feeInNaira: false, busy: false };

/* Wallets differ on Celo's fee currency field. MiniPay honours it, so gas comes
   out of the naira balance. Injected desktop wallets drop it and charge CELO,
   which the sender may not have, so say so rather than let the send fail. */
function detectFeeSupport(provider) {
  return Boolean(provider?.isMiniPay);
}

function setNet(kind, text) {
  $("netdot").className = `dot ${kind}`;
  $("nettext").textContent = text;
}

/* Wallet and node errors arrive as hex, nested cause chains, or vendor strings.
   None of that belongs in front of someone sending money. */
function plainError(e) {
  const raw = (e?.shortMessage || e?.details || e?.message || String(e || "")).toLowerCase();
  const code = e?.code;

  if (code === 4001 || raw.includes("user rejected") || raw.includes("user denied")) {
    return "You cancelled the transaction. Nothing was sent.";
  }
  if (code === 4902 || raw.includes("unrecognized chain")) {
    return "Celo is not set up in this wallet yet. Approve the prompt to add it.";
  }
  if (raw.includes("insufficient funds") || raw.includes("exceeds balance")) {
    return "Not enough naira to cover the amount plus the fee.";
  }
  if (raw.includes("gas required exceeds allowance")) {
    return "Your wallet could not estimate the fee. Try a slightly smaller amount.";
  }
  if (raw.includes("fee cap") || raw.includes("max fee per gas")) {
    return "The network got busy while you were signing. Try again.";
  }
  if (raw.includes("nonce")) {
    return "Another transaction from this wallet is still pending. Wait for it to finish.";
  }
  if (raw.includes("transfer amount exceeds balance")) {
    return "Your naira balance moved before this went through. Check it and try again.";
  }
  if (raw.includes("failed to fetch") || raw.includes("network error") || raw.includes("timeout")) {
    return "Could not reach the network. Check your connection and try again.";
  }
  return "The transaction did not go through. Nothing was sent.";
}

const ICONS = {
  spin: '<div class="spinner"></div>',
  ok: '<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><path d="M6 10.4l2.7 2.6L14 7.6"/></svg>',
  bad: '<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="8.5"/><path d="M10 6v5M10 14h.01"/></svg>',
};

function status(kind, msg, sub = "") {
  const box = $("status");
  $("status-ic").innerHTML = kind === "work" ? ICONS.spin : kind === "ok" ? ICONS.ok : ICONS.bad;
  $("status-msg").textContent = msg;
  $("status-sub").innerHTML = sub;
  const first = !box.classList.contains("on");
  box.classList.add("on");
  // Motion marks that the state changed. It never runs long enough to wait on.
  if (window.gsap && !reduced) {
    gsap.fromTo(box, { opacity: first ? 0 : 1, y: first ? 4 : 0 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" });
  }
}

function clearStatus() {
  $("status").classList.remove("on");
}

/* Three fixed stages: signed, mined, confirmed. Progress is a claim about where
   the transaction is, so it only ever moves forward when that is true. */
function step(n) {
  const bars = $("steps").querySelectorAll("i");
  $("steps").hidden = false;
  bars.forEach((bar, i) => {
    const done = i < n;
    if (window.gsap && !reduced) {
      gsap.to(bar, { scaleX: done ? 1 : 0, duration: 0.3, ease: "power2.out" });
    } else {
      bar.style.transform = `scaleX(${done ? 1 : 0})`;
    }
  });
}

function provider() {
  return window.ethereum ?? null;
}

async function loadBalance() {
  if (!state.account) return;
  const el = $("bal");
  el.classList.add("skel");
  try {
    const res = await fetch(`/v1/balance/${state.account}`);
    if (!res.ok) throw new Error("balance unavailable");
    const { balance } = await res.json();
    el.textContent = fmt(balance);
    el.dataset.raw = balance;
  } catch {
    el.textContent = "unavailable";
    el.dataset.raw = "";
  } finally {
    el.classList.remove("skel");
  }
}

async function ensureCelo() {
  const p = provider();
  const current = await p.request({ method: "eth_chainId" });
  state.chainId = parseInt(current, 16);
  if (state.chainId === CELO_ID) {
    setNet("live", "Celo");
    return true;
  }
  setNet("bad", "Wrong network");
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CELO_HEX }] });
  } catch (e) {
    if (e?.code === 4902) {
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CELO_HEX,
          chainName: "Celo",
          nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
          rpcUrls: ["https://forno.celo.org"],
          blockExplorerUrls: ["https://celoscan.io"],
        }],
      });
    } else {
      throw e;
    }
  }
  state.chainId = CELO_ID;
  setNet("live", "Celo");
  return true;
}

async function connect() {
  const p = provider();
  if (!p) {
    status("bad", "No wallet found.", "Open this page inside MiniPay, or install a Celo-compatible wallet.");
    return;
  }
  try {
    clearStatus();
    $("connect").disabled = true;
    $("connect").textContent = "Check your wallet";
    const accounts = await p.request({ method: "eth_requestAccounts" });
    state.account = accounts[0];
    state.feeInNaira = detectFeeSupport(p);
    await ensureCelo();

    $("addr").textContent = short(state.account);
    $("connect-wrap").hidden = true;
    $("cost-card").hidden = true;
    $("send-card").hidden = false;
    await loadBalance();
    showVerifyState();

    const note = $("gasnote");
    if (state.feeInNaira) {
      note.classList.add("hide");
    } else {
      note.classList.remove("hide");
      note.textContent = "This wallet pays gas in CELO, so you need a small CELO balance. Open Kobo in MiniPay to pay the fee in naira instead.";
    }
  } catch (e) {
    status("bad", plainError(e));
  } finally {
    $("connect").disabled = false;
    $("connect").textContent = "Connect wallet";
  }
}

let quoteTimer;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshQuote, 260);
}

function validate() {
  const to = $("to").value.trim();
  const amt = $("amt").value.trim();
  let ok = true;

  const toBad = to.length > 0 && !/^0x[a-fA-F0-9]{40}$/.test(to);
  $("to-err").textContent = toBad ? "That is not a valid Celo address." : "";
  $("to").setAttribute("aria-invalid", String(toBad));
  if (toBad || !to) ok = false;

  const n = Number(amt);
  const amtBad = amt.length > 0 && (!isFinite(n) || n <= 0);
  $("amt-err").textContent = amtBad ? "Enter an amount greater than zero." : "";
  $("amt").setAttribute("aria-invalid", String(amtBad));
  if (amtBad || !amt) ok = false;

  return ok;
}

async function refreshQuote() {
  const btn = $("send");
  if (!validate()) {
    $("quote").classList.remove("on");
    state.quote = null;
    btn.disabled = true;
    btn.textContent = $("amt").value.trim() ? "Check the details" : "Enter an amount";
    return;
  }
  try {
    const url = `/v1/quote?from=${state.account}&to=${$("to").value.trim()}&amount=${$("amt").value.trim()}`;
    const res = await fetch(url);
    const q = await res.json();
    if (!res.ok) throw new Error(q.error || "quote failed");

    state.quote = q;
    $("q-arrives").textContent = `₦${fmt(q.arrives)}`;
    $("q-fee").textContent = `₦${fmt(q.estimatedFee)}`;
    $("q-total").textContent = `₦${fmt(Number(q.amount) + Number(q.estimatedFee))}`;
    $("quote").classList.add("on");

    btn.disabled = !q.sufficient;
    btn.textContent = q.sufficient ? `Send ₦${fmt(q.amount)}` : "Not enough naira";
  } catch (e) {
    state.quote = null;
    $("quote").classList.remove("on");
    btn.disabled = true;
    btn.textContent = "Could not price this";
    $("amt-err").textContent = plainError(e);
  }
}

async function submit() {
  if (state.busy || !state.quote) return;
  const p = provider();
  state.busy = true;
  $("send").disabled = true;

  try {
    await ensureCelo();

    const res = await fetch("/v1/transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: $("to").value.trim(), amount: $("amt").value.trim() }),
    });
    const built = await res.json();
    if (!res.ok) throw new Error(built.error || "could not build the transfer");

    const tx = { from: state.account, to: built.transaction.to, data: built.transaction.data, gas: built.transaction.gas };
    if (state.feeInNaira) tx.feeCurrency = NGNM;

    step(0);
    status("work", "Confirm in your wallet.", "Nothing moves until you approve it.");
    const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });

    step(1);
    const link = `<a href="https://celoscan.io/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`;
    status("work", "Sent. Waiting for the network.", link);

    const receipt = await waitForReceipt(p, hash);
    if (receipt.status === "0x0" || receipt.status === 0) {
      step(1);
      status("bad", "The network rejected the transfer.", link);
      return;
    }

    step(3);
    status("ok", `₦${fmt(state.quote.amount)} sent.`, link);
    $("amt").value = "";
    $("quote").classList.remove("on");
    await loadBalance();
  } catch (e) {
    status("bad", plainError(e));
    $("steps").hidden = true;
  } finally {
    state.busy = false;
    refreshQuote();
  }
}

/* Celo finalises in one block, so a single confirmation is final. Polling stops
   after roughly two minutes rather than spinning forever. */
async function waitForReceipt(p, hash, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await p.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r) {
      step(2);
      return r;
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("timeout");
}

$("connect").addEventListener("click", connect);
$("send").addEventListener("click", submit);
$("to").addEventListener("input", scheduleQuote);
$("amt").addEventListener("input", scheduleQuote);

document.querySelectorAll("[data-amt]").forEach((b) =>
  b.addEventListener("click", () => {
    $("amt").value = b.dataset.amt;
    scheduleQuote();
  }),
);

$("chip-max").addEventListener("click", () => {
  const raw = $("bal").dataset.raw;
  if (!raw) return;
  // Leave the fee ceiling behind so Max cannot produce a transfer that fails.
  const spendable = Math.max(0, Number(raw) - 6);
  $("amt").value = spendable.toFixed(2);
  scheduleQuote();
});

const p = provider();
if (p) {
  setNet("", "Not connected");
  p.on?.("accountsChanged", (a) => {
    state.account = a[0] ?? null;
    if (!state.account) location.reload();
    else {
      $("addr").textContent = short(state.account);
      loadBalance();
    }
  });
  p.on?.("chainChanged", () => location.reload());
  // MiniPay authorises the page already, so skip the connect step there.
  if (p.isMiniPay) connect();
} else {
  setNet("bad", "No wallet");
  $("connect").textContent = "Open in MiniPay";
  $("connect").disabled = true;
}

/* Proof of personhood. The proof is produced on the person's phone and lands
   onchain without touching this page, so there is nothing to submit here: we
   ask the contract until it says yes. */
let verifyPoll = null;

async function refreshVerified() {
  if (!state.account) return null;
  try {
    const r = await fetch(`/v1/personhood/${state.account}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function showVerifyState() {
  const card = $("verify-card");
  const s = await refreshVerified();
  // Hidden entirely when the contract is not configured, rather than offering
  // a button that cannot work.
  if (!s?.configured) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("v-done").hidden = !s.verified;
  $("v-idle").hidden = s.verified;
  if (s.verified) {
    $("v-qr").hidden = true;
    if (verifyPoll) {
      clearInterval(verifyPoll);
      verifyPoll = null;
    }
  }
}

async function startVerify() {
  if (!state.account) return;
  const btn = $("v-start");
  btn.disabled = true;
  btn.textContent = "Preparing";
  try {
    const r = await fetch(`/v1/personhood/${state.account}/link`);
    if (!r.ok) throw new Error((await r.json()).error || "could not start");
    const { link, qr } = await r.json();

    $("v-qr-img").innerHTML = qr;
    $("v-open").href = link;
    $("v-idle").hidden = true;
    $("v-qr").hidden = false;

    // The page never sees the proof, so the chain is the only source of truth.
    verifyPoll = setInterval(async () => {
      const s = await refreshVerified();
      if (s?.verified) showVerifyState();
    }, 4000);
  } catch (e) {
    status("bad", plainError(e));
    btn.disabled = false;
    btn.textContent = "Prove I am a person";
  }
}

$("v-start").addEventListener("click", startVerify);

/* What a transfer costs, before any wallet exists. The fee does not depend on
   who is asking, so making someone connect first to find out is backwards. */
async function loadCost() {
  const card = $("cost-card");
  try {
    const r = await fetch("/v1/cost?amount=5000");
    if (!r.ok) throw new Error();
    const c = await r.json();

    $("c-amount").textContent = `₦${fmt(c.example)}`;
    $("c-arrives").textContent = `₦${fmt(c.arrives)}`;
    $("c-fee").textContent = `₦${fmt(c.estimatedFee)}`;
    $("c-total").textContent = `₦${fmt(c.total)}`;
    for (const id of ["c-arrives", "c-fee", "c-total"]) $(id).classList.remove("skel");

    if (!c.nairaAcceptedAsGas) {
      $("c-note").textContent =
        "Celo is not accepting naira for gas right now, so a transfer would need CELO. This is read from the chain on every load.";
    }
  } catch {
    // Better to remove the panel than to leave dashes where numbers belong,
    // which is the exact complaint that produced it.
    card.hidden = true;
  }
}

loadCost();
