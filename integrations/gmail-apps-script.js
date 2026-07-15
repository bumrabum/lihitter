function forwardVacancyEmails() {
  const endpoint = "https://YOUR-SERVER/webhooks/gmail";
  const secret = "replace-me";
  const threads = GmailApp.search('label:vacancies newer_than:1d');

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      const payload = {
        subject: message.getSubject(),
        from: message.getFrom(),
        text: message.getPlainBody(),
        html: message.getBody(),
        receivedAt: message.getDate().toISOString()
      };

      UrlFetchApp.fetch(endpoint, {
        method: "post",
        contentType: "application/json",
        headers: {
          "x-webhook-secret": secret
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    });
  });
}
