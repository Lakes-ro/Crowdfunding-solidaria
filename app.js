// ============================================================================
// app.js — Vaquinha da Lud
// ----------------------------------------------------------------------------
// JavaScript puro (sem frameworks). Responsável por:
//   1. Configurar o cliente Supabase (somente chave anônima / leitura via RLS)
//   2. Carregar e assinar via Realtime a tabela `events`
//   3. Controlar máscara de WhatsApp, atalhos de valor e validação do form
//   4. Chamar a Edge Function `create-checkout` e redirecionar ao pagamento
//   5. Detectar o retorno do checkout (redirect_url) e disparar confetes
// ============================================================================

(() => {
  "use strict";

  // --------------------------------------------------------------------
  // CONFIGURAÇÃO — ajuste estes valores para o seu projeto Supabase
  // --------------------------------------------------------------------
  const CONFIG = {
    SUPABASE_URL: "https://dzvrlhktcprlpxpszvky.supabase.co",
    SUPABASE_ANON_KEY:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6dnJsaGt0Y3BybHB4cHN6dmt5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxOTY3MzksImV4cCI6MjA5ODc3MjczOX0.G4QPmy_eS65020rTTDG_OnfFgkQlphDWXjleHsrnkgo",
    // Busca o evento pelo slug em vez de exigir um UUID fixo — basta bater
    // com a coluna `slug` inserida em public.events (ver database/schema.sql).
    EVENT_SLUG: "ludmila-15-anos",
    CREATE_CHECKOUT_FUNCTION_URL:
      "https://dzvrlhktcprlpxpszvky.supabase.co/functions/v1/create-checkout",
  };

  // Preenchido dinamicamente após a busca do evento por slug (ver initSupabaseRealtime).
  let currentEventId = null;

  const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 88; // r=88 definido no SVG (style.css/index.html)

  // --------------------------------------------------------------------
  // Referências de DOM
  // --------------------------------------------------------------------
  const els = {
    returnBanner: document.getElementById("return-banner"),
    returnBannerTitle: document.getElementById("return-banner-title"),
    closeBannerBtn: document.getElementById("closeBannerBtn"),

    sealRingFill: document.getElementById("sealRingFill"),
    percentLabel: document.getElementById("percentLabel"),
    raisedAmount: document.getElementById("raisedAmount"),
    goalAmount: document.getElementById("goalAmount"),
    ribbonBarFill: document.getElementById("ribbonBarFill"),
    liveStatus: document.getElementById("liveStatus"),

    donateForm: document.getElementById("donateForm"),
    donorName: document.getElementById("donorName"),
    donorWhatsapp: document.getElementById("donorWhatsapp"),
    donorMessage: document.getElementById("donorMessage"),
    donationAmount: document.getElementById("donationAmount"),
    amountShortcuts: document.querySelectorAll(".amount-shortcut"),
    formError: document.getElementById("formError"),
    donateSubmitBtn: document.getElementById("donateSubmitBtn"),

    donateLoading: document.getElementById("donateLoading"),
    donateFailed: document.getElementById("donateFailed"),
    donateFailedMessage: document.getElementById("donateFailedMessage"),
    donateRetryBtn: document.getElementById("donateRetryBtn"),
  };

  // --------------------------------------------------------------------
  // Utilitários de formatação
  // --------------------------------------------------------------------
  const currencyFormatter = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  function formatCurrency(value) {
    return currencyFormatter.format(Number(value) || 0);
  }

  function parseAmountInput(rawValue) {
    // Aceita "100", "100,50", "1.000,50" -> normaliza para número JS
    const normalized = rawValue
      .replace(/\./g, "")
      .replace(",", ".")
      .replace(/[^\d.]/g, "");
    return parseFloat(normalized);
  }

  // --------------------------------------------------------------------
  // Máscara de WhatsApp — formato (DDD) 9XXXX-XXXX, com foco nos DDDs
  // do interior do RJ (21/22/24), mas sem bloquear outros DDDs válidos.
  // --------------------------------------------------------------------
  function maskWhatsapp(value) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length === 0) return "";
    if (digits.length <= 2) return `(${digits}`;
    if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }

  els.donorWhatsapp.addEventListener("input", (event) => {
    const cursorWasAtEnd =
      event.target.selectionStart === event.target.value.length;
    event.target.value = maskWhatsapp(event.target.value);
    if (cursorWasAtEnd) {
      event.target.setSelectionRange(event.target.value.length, event.target.value.length);
    }
  });

  // --------------------------------------------------------------------
  // Atalhos de valor
  // --------------------------------------------------------------------
  els.amountShortcuts.forEach((button) => {
    button.addEventListener("click", () => {
      const amount = button.dataset.amount;
      els.donationAmount.value = amount.replace(".", ",");
      els.amountShortcuts.forEach((b) => b.classList.remove("is-selected"));
      button.classList.add("is-selected");
      clearFormError();
    });
  });

  els.donationAmount.addEventListener("input", () => {
    els.amountShortcuts.forEach((b) => b.classList.remove("is-selected"));
  });

  // --------------------------------------------------------------------
  // Estados visuais do formulário
  // --------------------------------------------------------------------
  function showFormState(state) {
    els.donateForm.hidden = state !== "form";
    els.donateLoading.hidden = state !== "loading";
    els.donateFailed.hidden = state !== "failed";
  }

  function showFormError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
  }

  function clearFormError() {
    els.formError.hidden = true;
    els.formError.textContent = "";
  }

  // --------------------------------------------------------------------
  // Submissão do formulário
  // --------------------------------------------------------------------
  els.donateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError();

    const donorName = els.donorName.value.trim();
    const donorWhatsappDigits = els.donorWhatsapp.value.replace(/\D/g, "");
    const message = els.donorMessage.value.trim();
    const amount = parseAmountInput(els.donationAmount.value || "");

    if (donorName.length === 0) {
      showFormError("Por favor, preencha seu nome.");
      els.donorName.focus();
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      showFormError("Informe um valor de contribuição válido.");
      els.donationAmount.focus();
      return;
    }

    if (amount < 5) {
      showFormError("O valor mínimo de contribuição é R$ 5,00.");
      els.donationAmount.focus();
      return;
    }

    if (donorWhatsappDigits.length > 0 && donorWhatsappDigits.length < 10) {
      showFormError("Informe um WhatsApp válido com DDD, ou deixe em branco.");
      els.donorWhatsapp.focus();
      return;
    }

    if (!currentEventId) {
      showFormError("A arrecadação ainda está carregando. Aguarde um instante e tente novamente.");
      return;
    }

    showFormState("loading");
    els.donateSubmitBtn.disabled = true;

    try {
      const response = await fetch(CONFIG.CREATE_CHECKOUT_FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: currentEventId,
          donor_name: donorName,
          donor_whatsapp: donorWhatsappDigits || null,
          message: message || null,
          amount: amount,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.checkout_url) {
        throw new Error(data.error || "Não foi possível gerar o link de pagamento.");
      }

      // Redireciona imediatamente para o checkout hospedado da InfinitePay
      window.location.href = data.checkout_url;
    } catch (error) {
      console.error("Falha ao criar checkout:", error);
      els.donateFailedMessage.textContent =
        error.message || "Não foi possível iniciar sua contribuição. Tente novamente.";
      showFormState("failed");
      els.donateSubmitBtn.disabled = false;
    }
  });

  els.donateRetryBtn.addEventListener("click", () => {
    showFormState("form");
    els.donateSubmitBtn.disabled = false;
  });

  // --------------------------------------------------------------------
  // Atualização visual do progresso (selo + faixa + números)
  // --------------------------------------------------------------------
  let lastKnownAmount = null;

  function updateProgressUI(currentAmount, goalAmountValue) {
    const safeGoal = Number(goalAmountValue) > 0 ? Number(goalAmountValue) : 1;
    const ratio = Math.min(Number(currentAmount) / safeGoal, 1);
    const percent = Math.round(ratio * 100);

    els.percentLabel.textContent = `${percent}%`;
    els.raisedAmount.textContent = formatCurrency(currentAmount);
    els.goalAmount.textContent = formatCurrency(goalAmountValue);
    els.ribbonBarFill.style.width = `${percent}%`;

    const offset = CIRCLE_CIRCUMFERENCE * (1 - ratio);
    els.sealRingFill.style.strokeDasharray = `${CIRCLE_CIRCUMFERENCE}`;
    els.sealRingFill.style.strokeDashoffset = `${offset}`;
  }

  function celebrateIfIncreased(newAmount) {
    if (lastKnownAmount !== null && Number(newAmount) > Number(lastKnownAmount)) {
      fireConfetti();
      els.liveStatus.textContent = "Uma nova contribuição chegou agora mesmo! 🎉";
      els.liveStatus.classList.add("progress-card__status--live");
    }
    lastKnownAmount = newAmount;
  }

  function fireConfetti() {
    if (typeof confetti !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const colors = ["#c9a66b", "#e8b4b8", "#712338", "#f6ecdd"];
    confetti({
      particleCount: 120,
      spread: 80,
      startVelocity: 42,
      origin: { y: 0.6 },
      colors,
    });
    setTimeout(() => {
      confetti({
        particleCount: 60,
        spread: 100,
        startVelocity: 30,
        origin: { y: 0.5 },
        colors,
      });
    }, 250);
  }

  // --------------------------------------------------------------------
  // Supabase — carregamento inicial + Realtime
  // --------------------------------------------------------------------
  async function initSupabaseRealtime() {
    if (CONFIG.SUPABASE_URL.includes("SEU-PROJETO") || !CONFIG.EVENT_SLUG) {
      console.warn(
        "Configure CONFIG.SUPABASE_URL, SUPABASE_ANON_KEY e EVENT_SLUG em app.js antes de publicar.",
      );
      els.liveStatus.textContent = "Configuração pendente.";
      return;
    }

    const { createClient } = window.supabase;
    const supabaseClient = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

    // Carga inicial via SELECT (permitido pela policy de leitura pública).
    // Busca pelo slug: não é preciso conhecer o UUID do evento de antemão.
    const { data: event, error } = await supabaseClient
      .from("events")
      .select("id, current_amount, goal_amount")
      .eq("slug", CONFIG.EVENT_SLUG)
      .single();

    if (error || !event) {
      console.error("Erro ao carregar evento:", error);
      els.liveStatus.textContent = "Não foi possível carregar os dados da arrecadação.";
      return;
    }

    currentEventId = event.id;
    lastKnownAmount = event.current_amount;
    updateProgressUI(event.current_amount, event.goal_amount);
    els.liveStatus.textContent = "Acompanhando em tempo real…";
    els.liveStatus.classList.add("progress-card__status--live");

    // Assinatura Realtime: qualquer UPDATE na linha do evento atualiza a tela
    // sem necessidade de F5.
    supabaseClient
      .channel(`event-progress-${currentEventId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "events",
          filter: `id=eq.${currentEventId}`,
        },
        (payload) => {
          const updated = payload.new;
          celebrateIfIncreased(updated.current_amount);
          updateProgressUI(updated.current_amount, updated.goal_amount);
        },
      )
      .subscribe();
  }

  // --------------------------------------------------------------------
  // Detecção de retorno do checkout InfinitePay (redirect_url)
  // A InfinitePay anexa parâmetros como order_nsu / receipt_url na URL de
  // retorno. Se detectados, exibimos a faixa de agradecimento e confetes
  // imediatamente, sem esperar o Realtime (o webhook pode levar alguns
  // segundos a mais para confirmar no banco).
  // --------------------------------------------------------------------
  function checkReturnFromCheckout() {
    const params = new URLSearchParams(window.location.search);
    const hasReturnedFromPayment =
      params.has("order_nsu") || params.has("receipt_url") || params.has("transaction_nsu");

    if (!hasReturnedFromPayment) return;

    els.returnBanner.hidden = false;
    fireConfetti();

    // Limpa a URL para evitar reexibir a faixa em um F5 manual
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  els.closeBannerBtn.addEventListener("click", () => {
    els.returnBanner.hidden = true;
  });

  // --------------------------------------------------------------------
  // Inicialização
  // --------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    checkReturnFromCheckout();
    initSupabaseRealtime();
  });
})();
