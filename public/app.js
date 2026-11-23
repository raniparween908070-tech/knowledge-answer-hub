(function () {
  'use strict';

  var MAX_QUESTION_LEN = 1200;
  var RTL_LANGUAGES = new Set(['Urdu', 'Arabic']);

  // Mobile menu toggle (shared across all pages)
  function initMobileNav() {
    var toggleBtn = document.getElementById('mobile-menu-toggle');
    var mobileNav = document.getElementById('mobile-nav');
    if (!toggleBtn || !mobileNav) {
      return;
    }

    toggleBtn.addEventListener('click', function () {
      var isOpen = mobileNav.classList.toggle('is-open');
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
    });
  }

  // Safe inline Markdown formatting using DOM nodes only (no innerHTML)
  function appendFormattedInline(parent, text) {
    var pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
    var lastIndex = 0;
    var match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      var token = match[0];
      if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
        var strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        parent.appendChild(strong);
      } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
        var em = document.createElement('em');
        em.textContent = token.slice(1, -1);
        parent.appendChild(em);
      } else if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
        var code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else {
        parent.appendChild(document.createTextNode(token));
      }

      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  // Safe Markdown-to-DOM block renderer
  function renderAnswerMarkdown(container, markdownText) {
    container.textContent = '';
    var lines = String(markdownText || '').replace(/\r\n/g, '\n').split('\n');
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      // Fenced code block
      if (trimmed.startsWith('```')) {
        var codeLines = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i += 1;
        }
        i += 1;
        var pre = document.createElement('pre');
        var codeEl = document.createElement('code');
        codeEl.textContent = codeLines.join('\n');
        pre.appendChild(codeEl);
        container.appendChild(pre);
        continue;
      }

      // Headings (#, ##, ###, ####)
      var headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        var level = Math.min(headingMatch[1].length + 1, 4);
        var heading = document.createElement('h' + level);
        appendFormattedInline(heading, headingMatch[2]);
        container.appendChild(heading);
        i += 1;
        continue;
      }

      // Unordered list (- or *)
      if (/^[-*+]\s+/.test(trimmed)) {
        var ul = document.createElement('ul');
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          var li = document.createElement('li');
          appendFormattedInline(li, lines[i].trim().replace(/^[-*+]\s+/, ''));
          ul.appendChild(li);
          i += 1;
        }
        container.appendChild(ul);
        continue;
      }

      // Ordered list (1. 2. ...)
      if (/^\d+\.\s+/.test(trimmed)) {
        var ol = document.createElement('ol');
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          var oli = document.createElement('li');
          appendFormattedInline(oli, lines[i].trim().replace(/^\d+\.\s+/, ''));
          ol.appendChild(oli);
          i += 1;
        }
        container.appendChild(ol);
        continue;
      }

      // Paragraph (collect consecutive plain lines)
      var paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !lines[i].trim().startsWith('```') &&
        !/^#{1,4}\s+/.test(lines[i].trim()) &&
        !/^[-*+]\s+/.test(lines[i].trim()) &&
        !/^\d+\.\s+/.test(lines[i].trim())
      ) {
        paraLines.push(lines[i].trim());
        i += 1;
      }
      var p = document.createElement('p');
      appendFormattedInline(p, paraLines.join(' '));
      container.appendChild(p);
    }
  }

  function initQuestionHub() {
    var form = document.getElementById('question-form');
    if (!form) {
      return;
    }

    var questionInput = document.getElementById('question-input');
    var subjectSelect = document.getElementById('subject-select');
    var languageSelect = document.getElementById('language-select');
    var charCounter = document.getElementById('char-counter');
    var askBtn = document.getElementById('ask-btn');
    var clearBtn = document.getElementById('clear-btn');

    var errorBanner = document.getElementById('hub-error');
    var errorText = document.getElementById('hub-error-text');
    var loadingPanel = document.getElementById('loading-panel');

    var answerSection = document.getElementById('answer-section');
    var answerMeta = document.getElementById('answer-meta');
    var threadList = document.getElementById('thread-list');
    var copyBtn = document.getElementById('copy-answer-btn');
    var anotherBtn = document.getElementById('ask-another-btn');

    var followupForm = document.getElementById('followup-form');
    var followupInput = document.getElementById('followup-input');
    var followupBtn = document.getElementById('followup-btn');

    var conversationTurns = [];
    var isLoading = false;

    function updateCounter() {
      var len = questionInput.value.length;
      charCounter.textContent = len + ' / ' + MAX_QUESTION_LEN;
    }

    function showError(msg) {
      errorText.textContent = msg;
      errorBanner.classList.remove('is-hidden');
    }

    function hideError() {
      errorBanner.classList.add('is-hidden');
      errorText.textContent = '';
    }

    function setBusy(busy) {
      isLoading = busy;
      askBtn.disabled = busy;
      clearBtn.disabled = busy;
      if (followupBtn) {
        followupBtn.disabled = busy;
      }
      askBtn.textContent = busy ? 'Generating Answer...' : 'Ask Question';
      if (busy) {
        loadingPanel.classList.remove('is-hidden');
      } else {
        loadingPanel.classList.add('is-hidden');
      }
    }

    function renderThread() {
      threadList.textContent = '';

      if (conversationTurns.length === 0) {
        answerSection.classList.add('is-hidden');
        return;
      }

      var latest = conversationTurns[conversationTurns.length - 1];
      answerMeta.textContent = '';
      var metaLabel = document.createElement('strong');
      metaLabel.textContent = latest.subject;
      answerMeta.appendChild(metaLabel);
      answerMeta.appendChild(document.createTextNode(' · ' + latest.language));

      conversationTurns.forEach(function (turn) {
        var turnDiv = document.createElement('article');
        turnDiv.className = 'thread-turn';

        var qDiv = document.createElement('div');
        qDiv.className = 'turn-question';
        qDiv.textContent = turn.question;

        var aDiv = document.createElement('div');
        aDiv.className = 'turn-answer';
        if (RTL_LANGUAGES.has(turn.language)) {
          aDiv.setAttribute('dir', 'rtl');
        }
        renderAnswerMarkdown(aDiv, turn.answer);

        turnDiv.appendChild(qDiv);
        turnDiv.appendChild(aDiv);
        threadList.appendChild(turnDiv);
      });

      answerSection.classList.remove('is-hidden');
    }

    async function submitQuestion(questionText, isFollowup) {
      if (isLoading) {
        return;
      }

      var trimmed = String(questionText || '').trim();
      hideError();

      if (!trimmed) {
        showError('Please enter a question before clicking Ask Question.');
        if (!isFollowup) {
          questionInput.focus();
        } else if (followupInput) {
          followupInput.focus();
        }
        return;
      }

      if (trimmed.length > MAX_QUESTION_LEN) {
        showError('Please keep your question under ' + MAX_QUESTION_LEN + ' characters.');
        return;
      }

      var subject = subjectSelect.value;
      var language = languageSelect.value;

      var historyPayload = [];
      if (isFollowup && conversationTurns.length > 0) {
        conversationTurns.forEach(function (turn) {
          historyPayload.push({ role: 'user', text: turn.question });
          historyPayload.push({ role: 'model', text: turn.answer });
        });
      }

      setBusy(true);

      try {
        var response = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: trimmed,
            subject: subject,
            language: language,
            history: historyPayload,
          }),
        });

        var data = {};
        try {
          data = await response.json();
        } catch (_parseErr) {
          data = {};
        }

        if (!response.ok) {
          showError(
            data.error || 'We could not generate an answer right now. Please try again.'
          );
          return;
        }

        if (!data.answer) {
          showError('The server returned an empty response. Please try asking again.');
          return;
        }

        if (!isFollowup) {
          conversationTurns = [];
        } else if (followupInput) {
          followupInput.value = '';
        }

        conversationTurns.push({
          question: trimmed,
          answer: data.answer,
          subject: data.subject || subject,
          language: data.language || language,
        });

        renderThread();
        answerSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (_networkErr) {
        showError(
          'Network error: Unable to reach the server. Please check your connection and try again.'
        );
      } finally {
        setBusy(false);
      }
    }

    questionInput.addEventListener('input', updateCounter);
    updateCounter();

    questionInput.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        submitQuestion(questionInput.value, false);
      }
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitQuestion(questionInput.value, false);
    });

    if (followupForm) {
      followupForm.addEventListener('submit', function (event) {
        event.preventDefault();
        submitQuestion(followupInput.value, true);
      });
    }

    clearBtn.addEventListener('click', function () {
      questionInput.value = '';
      if (followupInput) {
        followupInput.value = '';
      }
      conversationTurns = [];
      updateCounter();
      hideError();
      renderThread();
      questionInput.focus();
    });

    if (anotherBtn) {
      anotherBtn.addEventListener('click', function () {
        questionInput.value = '';
        updateCounter();
        hideError();
        questionInput.focus();
        document.getElementById('ask-hub').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        if (conversationTurns.length === 0) {
          return;
        }
        var latestAnswer = conversationTurns[conversationTurns.length - 1].answer;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(latestAnswer);
          } else {
            var tempArea = document.createElement('textarea');
            tempArea.value = latestAnswer;
            tempArea.setAttribute('readonly', '');
            tempArea.style.position = 'fixed';
            tempArea.style.opacity = '0';
            document.body.appendChild(tempArea);
            tempArea.select();
            document.execCommand('copy');
            document.body.removeChild(tempArea);
          }
          var originalLabel = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(function () {
            copyBtn.textContent = originalLabel;
          }, 2000);
        } catch (_copyErr) {
          showError('Could not copy automatically. Please select the answer text to copy.');
        }
      });
    }

    // Popular question example buttons
    var exampleButtons = document.querySelectorAll('[data-example-question]');
    exampleButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var q = btn.getAttribute('data-example-question') || '';
        var s = btn.getAttribute('data-example-subject') || 'General Knowledge';
        questionInput.value = q;
        subjectSelect.value = s;
        updateCounter();
        document.getElementById('ask-hub').scrollIntoView({ behavior: 'smooth', block: 'start' });
        submitQuestion(q, false);
      });
    });
  }

  function initContactForm() {
    var contactForm = document.getElementById('contact-form');
    if (!contactForm) {
      return;
    }

    var nameInput = document.getElementById('contact-name');
    var emailInput = document.getElementById('contact-email');
    var subjectInput = document.getElementById('contact-subject');
    var messageInput = document.getElementById('contact-message');
    var submitBtn = document.getElementById('contact-submit-btn');

    var errorBanner = document.getElementById('contact-error');
    var errorText = document.getElementById('contact-error-text');
    var successBanner = document.getElementById('contact-success');
    var successText = document.getElementById('contact-success-text');

    function hideMessages() {
      errorBanner.classList.add('is-hidden');
      successBanner.classList.add('is-hidden');
    }

    function showContactError(msg) {
      errorText.textContent = msg;
      errorBanner.classList.remove('is-hidden');
    }

    function showContactSuccess(msg) {
      successText.textContent = msg;
      successBanner.classList.remove('is-hidden');
    }

    contactForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      hideMessages();

      var name = nameInput.value.trim();
      var email = emailInput.value.trim();
      var subject = subjectInput.value.trim();
      var message = messageInput.value.trim();

      if (name.length < 2) {
        showContactError('Please enter your full name (at least 2 characters).');
        nameInput.focus();
        return;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        showContactError('Please enter a valid email address.');
        emailInput.focus();
        return;
      }

      if (subject.length < 3) {
        showContactError('Please enter a subject (at least 3 characters).');
        subjectInput.focus();
        return;
      }

      if (message.length < 10) {
        showContactError('Please write a message of at least 10 characters.');
        messageInput.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending Message...';

      try {
        var formData = new FormData(contactForm);
        formData.set('name', name);
        formData.set('email', email);
        formData.set('subject', subject);
        formData.set('message', message);

        var response = await fetch('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(formData).toString(),
        });

        if (!response.ok) {
          showContactError('Could not submit your message right now. Please try again.');
          return;
        }

        showContactSuccess(
          'Thank you for your message. It has been sent securely to our team for review.'
        );
        contactForm.reset();
      } catch (_networkErr) {
        showContactError(
          'Network error: Unable to submit your message right now. Please try again.'
        );
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Message';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initMobileNav();
    initQuestionHub();
    initContactForm();
  });
})();
