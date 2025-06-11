import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import type { Update } from "telegraf/typings/core/types/typegram";
import type { VisaAppointment } from "../types";
import { config } from "../config/environment";

// Türkiye saat dilimini ayarla
process.env.TZ = 'Europe/Istanbul';

interface TelegramError {
  response?: {
    parameters?: {
      retry_after?: number;
    };
  };
}

/**
 * Telegram servis sınıfı
 * Telegram mesajlarının gönderilmesi ve bot yönetiminden sorumludur
 */
class TelegramService {
  private bot: Telegraf;
  private lastMessageSentAt: number = 0;
  private messageQueue: VisaAppointment[] = [];
  private isProcessingQueue: boolean = false;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
  }

  // HTML için özel karakterleri escape eder
  private escapeHtml(text: string): string {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Randevu bilgilerini Telegram mesajı olarak biçimlendirir (HTML formatında)
  private formatMessage(appointment: VisaAppointment): string {
    const statusEmoji =
      appointment.status === 'open'
        ? '✅'
        : appointment.status === 'waitlist_open'
        ? '⏳'
        : '❓';
    
    const statusText = 
      appointment.status === 'open'
        ? 'Açık'
        : appointment.status === 'waitlist_open'
        ? 'Bekleme Listesi Açık'
        : appointment.status;

    const lastCheckedDate = new Date(appointment.last_checked_at).toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const message = `<b>${statusEmoji} YENİ RANDEVU DURUMU</b>

🏢 <b>Merkez:</b> ${this.escapeHtml(appointment.center)}
🌍 <b>Ülke/Misyon:</b> ${this.escapeHtml(appointment.country_code.toUpperCase())} → ${this.escapeHtml(appointment.mission_code.toUpperCase())}
🛂 <b>Kategori:</b> ${this.escapeHtml(appointment.visa_category || 'Belirtilmemiş')}
📄 <b>Tip:</b> ${this.escapeHtml(appointment.visa_type || 'Belirtilmemiş')}
🚦 <b>Durum:</b> ${statusEmoji} ${this.escapeHtml(statusText)}
🗓️ <b>Son Müsait Tarih:</b> ${this.escapeHtml(appointment.last_available_date || 'Belirtilmemiş')}
📊 <b>Takip Sayısı:</b> ${appointment.tracking_count || 0}
⏰ <b>Son Kontrol:</b> ${this.escapeHtml(lastCheckedDate)}

<i>Bu randevu otomatik olarak tespit edilmiştir.</i>`;

    return message;
  }

  // Telegram'a bildirim gönderir
  async sendNotification(appointment: VisaAppointment): Promise<boolean> {
    this.messageQueue.push(appointment);
    if (!this.isProcessingQueue) {
      void this.processQueue();
    }
    return true; // Kuyruğa eklendiğini belirtmek için hemen true döner
  }

  private async processQueue(): Promise<void> {
    this.isProcessingQueue = true;
    while (this.messageQueue.length > 0) {
      const appointment = this.messageQueue.shift();
      if (!appointment) continue;

      const now = Date.now();
      const timeSinceLastMessage = now - this.lastMessageSentAt;
      const requiredDelay = (60 / config.telegram.rateLimit) * 1000; // ms cinsinden

      if (timeSinceLastMessage < requiredDelay) {
        const delay = requiredDelay - timeSinceLastMessage;
        if (config.app.debug) {
          console.log(
            `⏳ Rate limit nedeniyle ${delay.toFixed(0)}ms bekleniyor...`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const message = this.formatMessage(appointment);
      try {
        if (config.app.debug) {
          console.log(`📤 Yeni randevu bildirimi gönderiliyor (ID: ${appointment.id})...`);
        }

        await this.bot.telegram.sendMessage(config.telegram.channelId, message, {
          parse_mode: 'HTML', // MarkdownV2 yerine HTML kullanıyoruz
        });

        if (config.app.debug) {
          console.log(`✅ Bildirim başarıyla gönderildi: ID ${appointment.id}`);
        }
        this.lastMessageSentAt = Date.now();
      } catch (error) {
        console.error(
          `❌ Telegram bildirim hatası (ID: ${appointment.id}):`,
          error instanceof Error ? error.message : error
        );
        
        // Eğer parsing hatası değilse tekrar dene
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes("can't parse entities") && !errorMessage.includes("Bad Request")) {
          // Hata durumunda mesajı kuyruğun başına geri ekle ve tekrar dene
          this.messageQueue.unshift(appointment);
          if (config.app.debug) {
            console.log(`🔄 Tekrar deneme için mesaj kuyruğa geri eklendi.`);
          }
          // Hata durumunda kısa bir bekleme ekleyebiliriz
          await new Promise((resolve) => setTimeout(resolve, config.telegram.retryAfter));
          break; // Kuyruğu durdur ve bir sonraki döngüde tekrar dene
        } else {
          // Parsing hatası ise mesajı logla ve atla
          console.error(`⚠️ Mesaj formatı hatası, atlanıyor: ID ${appointment.id}`);
        }
      }
    }
    this.isProcessingQueue = false;
  }
}

export const telegramService = new TelegramService();
