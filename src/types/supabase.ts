export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      _prisma_migrations: {
        Row: {
          applied_steps_count: number
          checksum: string
          finished_at: string | null
          id: string
          logs: string | null
          migration_name: string
          rolled_back_at: string | null
          started_at: string
        }
        Insert: {
          applied_steps_count?: number
          checksum: string
          finished_at?: string | null
          id: string
          logs?: string | null
          migration_name: string
          rolled_back_at?: string | null
          started_at?: string
        }
        Update: {
          applied_steps_count?: number
          checksum?: string
          finished_at?: string | null
          id?: string
          logs?: string | null
          migration_name?: string
          rolled_back_at?: string | null
          started_at?: string
        }
        Relationships: []
      }
      business_blocked_dates: {
        Row: {
          business_id: string
          created_at: string
          date: string
          id: string
          reason: string | null
          reason_message: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          date: string
          id?: string
          reason?: string | null
          reason_message?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          date?: string
          id?: string
          reason?: string | null
          reason_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_blocked_dates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          address: string | null
          address_lat: number | null
          address_lng: number | null
          address_osm_id: string | null
          ai_chat_enabled: boolean
          auto_accept_reservations: boolean
          city: string | null
          country: string | null
          cover_image_url: string | null
          created_at: string
          description: string | null
          food_type: string | null
          future_reservations_blocked_for_date: string | null
          id: string
          language: string
          last_jornada_closed_at: string | null
          listing_rejected_reason: string | null
          listing_status: Database["public"]["Enums"]["ListingStatus"]
          manual_table_occupancy_enabled: boolean
          name: string
          public_join_enabled: boolean
          public_screen_enabled: boolean
          requires_party_size: boolean
          reservation_closing_margin_minutes: number
          reservation_opening_margin_minutes: number
          supports_tables: boolean
          type: string
          updated_at: string
          weekly_hours: Json | null
          whatsapp_phone_number: string | null
          whatsapp_session_id: string | null
        }
        Insert: {
          address?: string | null
          address_lat?: number | null
          address_lng?: number | null
          address_osm_id?: string | null
          ai_chat_enabled?: boolean
          auto_accept_reservations?: boolean
          city?: string | null
          country?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          food_type?: string | null
          future_reservations_blocked_for_date?: string | null
          id?: string
          language?: string
          last_jornada_closed_at?: string | null
          listing_rejected_reason?: string | null
          listing_status?: Database["public"]["Enums"]["ListingStatus"]
          manual_table_occupancy_enabled?: boolean
          name: string
          public_join_enabled?: boolean
          public_screen_enabled?: boolean
          requires_party_size?: boolean
          reservation_closing_margin_minutes?: number
          reservation_opening_margin_minutes?: number
          supports_tables?: boolean
          type?: string
          updated_at?: string
          weekly_hours?: Json | null
          whatsapp_phone_number?: string | null
          whatsapp_session_id?: string | null
        }
        Update: {
          address?: string | null
          address_lat?: number | null
          address_lng?: number | null
          address_osm_id?: string | null
          ai_chat_enabled?: boolean
          auto_accept_reservations?: boolean
          city?: string | null
          country?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          food_type?: string | null
          future_reservations_blocked_for_date?: string | null
          id?: string
          language?: string
          last_jornada_closed_at?: string | null
          listing_rejected_reason?: string | null
          listing_status?: Database["public"]["Enums"]["ListingStatus"]
          manual_table_occupancy_enabled?: boolean
          name?: string
          public_join_enabled?: boolean
          public_screen_enabled?: boolean
          requires_party_size?: boolean
          reservation_closing_margin_minutes?: number
          reservation_opening_margin_minutes?: number
          supports_tables?: boolean
          type?: string
          updated_at?: string
          weekly_hours?: Json | null
          whatsapp_phone_number?: string | null
          whatsapp_session_id?: string | null
        }
        Relationships: []
      }
      customers: {
        Row: {
          business_id: string
          created_at: string
          first_seen_at: string
          id: string
          last_seen_at: string
          name: string
          phone: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          name: string
          phone?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          name?: string
          phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          created_by_id: string
          email: string
          expires_at: string
          id: string
          last_sent_at: string | null
          resend_token: string | null
          send_count: number
          status: Database["public"]["Enums"]["InvitationStatus"]
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          created_by_id: string
          email: string
          expires_at: string
          id?: string
          last_sent_at?: string | null
          resend_token?: string | null
          send_count?: number
          status?: Database["public"]["Enums"]["InvitationStatus"]
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          created_by_id?: string
          email?: string
          expires_at?: string
          id?: string
          last_sent_at?: string | null
          resend_token?: string | null
          send_count?: number
          status?: Database["public"]["Enums"]["InvitationStatus"]
        }
        Relationships: [
          {
            foreignKeyName: "invitations_created_by_id_fkey"
            columns: ["created_by_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tables: {
        Row: {
          business_id: string
          capacity: number
          created_at: string
          id: string
          is_active: boolean
          is_occupied: boolean
          name: string
          updated_at: string
        }
        Insert: {
          business_id: string
          capacity?: number
          created_at?: string
          id?: string
          is_active?: boolean
          is_occupied?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          capacity?: number
          created_at?: string
          id?: string
          is_active?: boolean
          is_occupied?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tables_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          business_id: string | null
          created_at: string
          email: string
          id: string
          role: Database["public"]["Enums"]["UserRole"]
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          email: string
          id: string
          role?: Database["public"]["Enums"]["UserRole"]
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          created_at?: string
          email?: string
          id?: string
          role?: Database["public"]["Enums"]["UserRole"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist_entries: {
        Row: {
          business_id: string
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          customer_id: string
          display_code: string
          estimated_wait_minutes: number | null
          id: string
          notified_at: string | null
          party_size: number
          queued_at: string
          scheduled_at: string | null
          seated_at: string | null
          source: Database["public"]["Enums"]["EntrySource"]
          status: Database["public"]["Enums"]["WaitlistStatus"]
          table_id: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          customer_id: string
          display_code: string
          estimated_wait_minutes?: number | null
          id?: string
          notified_at?: string | null
          party_size: number
          queued_at?: string
          scheduled_at?: string | null
          seated_at?: string | null
          source?: Database["public"]["Enums"]["EntrySource"]
          status?: Database["public"]["Enums"]["WaitlistStatus"]
          table_id?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          customer_id?: string
          display_code?: string
          estimated_wait_minutes?: number | null
          id?: string
          notified_at?: string | null
          party_size?: number
          queued_at?: string
          scheduled_at?: string | null
          seated_at?: string | null
          source?: Database["public"]["Enums"]["EntrySource"]
          status?: Database["public"]["Enums"]["WaitlistStatus"]
          table_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waitlist_entries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waitlist_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waitlist_entries_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "tables"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      EntrySource:
        | "DASHBOARD"
        | "PUBLIC_JOIN"
        | "AI_CHAT"
        | "PUBLIC_SCREEN"
        | "API"
      InvitationStatus: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED"
      ListingStatus: "DISABLED" | "PENDING" | "ACTIVE" | "REJECTED"
      UserRole: "ADMIN" | "OWNER"
      WaitlistStatus:
        | "WAITING"
        | "CONFIRMED"
        | "NOTIFIED"
        | "SEATED"
        | "CANCELLED"
        | "NO_SHOW"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      EntrySource: [
        "DASHBOARD",
        "PUBLIC_JOIN",
        "AI_CHAT",
        "PUBLIC_SCREEN",
        "API",
      ],
      InvitationStatus: ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"],
      ListingStatus: ["DISABLED", "PENDING", "ACTIVE", "REJECTED"],
      UserRole: ["ADMIN", "OWNER"],
      WaitlistStatus: [
        "WAITING",
        "CONFIRMED",
        "NOTIFIED",
        "SEATED",
        "CANCELLED",
        "NO_SHOW",
      ],
    },
  },
} as const
