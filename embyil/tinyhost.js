class TempMailAPI {
  constructor(baseUrl = 'https://tinyhost.shop') {
    this.baseUrl = baseUrl;
  }

  async getRandomDomains(limit = 20) {
    const url = `${this.baseUrl}/api/random-domains/?limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async getEmails(domain, user, page = 1, limit = 20) {
    const url = `${this.baseUrl}/api/email/${domain}/${user}/?page=${page}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async getEmailDetail(domain, user, emailId) {
    const url = `${this.baseUrl}/api/email/${domain}/${user}/${emailId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async pollForEmail(domain, user, filters = {}, timeoutMs = 120000, intervalMs = 3000) {
    const startTime = Date.now();
    const { subjectKeyword, senderKeyword } = filters;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const data = await this.getEmails(domain, user);
        const email = data.emails && data.emails.find(e => {
          let match = true;
          if (subjectKeyword) match = match && e.subject && e.subject.toLowerCase().includes(subjectKeyword.toLowerCase());
          if (senderKeyword) match = match && e.sender && e.sender.toLowerCase().includes(senderKeyword.toLowerCase());
          return match;
        });
        if (email) return await this.getEmailDetail(domain, user, email.id);
      } catch (err) {
        console.error('Polling error:', err.message);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('Timeout waiting for email');
  }
}

module.exports = TempMailAPI;
