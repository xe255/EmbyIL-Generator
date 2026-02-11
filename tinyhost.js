const axios = require('axios');

class TempMailAPI {
  constructor(baseUrl = 'https://tinyhost.shop') {
    this.baseUrl = baseUrl;
  }

  async getRandomDomains(limit = 20) {
    const response = await axios.get(`${this.baseUrl}/api/random-domains/`, {
      params: { limit }
    });
    return response.data;
  }

  async getEmails(domain, user, page = 1, limit = 20) {
    const response = await axios.get(`${this.baseUrl}/api/email/${domain}/${user}/`, {
      params: { page, limit }
    });
    return response.data;
  }

  async getEmailDetail(domain, user, emailId) {
    const response = await axios.get(`${this.baseUrl}/api/email/${domain}/${user}/${emailId}`);
    return response.data;
  }

  /**
   * Polls for an email with a specific keyword in the subject or from a specific sender.
   * @param {string} domain 
   * @param {string} user 
   * @param {Object} filters { subjectKeyword, senderKeyword }
   * @param {number} timeoutMs 
   * @param {number} intervalMs 
   */
  async pollForEmail(domain, user, filters = {}, timeoutMs = 120000, intervalMs = 5000) {
    const startTime = Date.now();
    const { subjectKeyword, senderKeyword } = filters;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const data = await this.getEmails(domain, user);
        const email = data.emails.find(e => {
          let match = true;
          if (subjectKeyword) match = match && e.subject.toLowerCase().includes(subjectKeyword.toLowerCase());
          if (senderKeyword) match = match && e.sender.toLowerCase().includes(senderKeyword.toLowerCase());
          return match;
        });
        if (email) {
          return await this.getEmailDetail(domain, user, email.id);
        }
      } catch (error) {
        console.error('Polling error:', error.message);
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timeout waiting for email');
  }
}

module.exports = TempMailAPI;
