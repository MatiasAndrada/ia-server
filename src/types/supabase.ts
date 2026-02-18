export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      businesses: {
        Row: {
          id: string
          name: string
          type: string
          public_screen_enabled: boolean
          created_at: string
          updated_at: string
          ai_chat_enabled: boolean
          language: string
          requires_party_size: boolean
          supports_tables: boolean
          whatsapp_phone_number: string
          whatsapp_session_id: string
          auto_accept_reservations?: boolean | null
        }
        Insert: {
          id?: string
          name: string
          type: string
          public_screen_enabled: boolean
          created_at?: string
          updated_at?: string
          ai_chat_enabled: boolean
          language: string
          requires_party_size: boolean
          supports_tables: boolean
          whatsapp_phone_number: string
          whatsapp_session_id: string
          auto_accept_reservations?: boolean | null
        }
        Update: {
          id?: string
          name?: string
          type?: string
          public_screen_enabled?: boolean
          created_at?: string
          updated_at?: string
          ai_chat_enabled?: boolean
          language?: string
          requires_party_size?: boolean
          supports_tables?: boolean
          whatsapp_phone_number?: string
          whatsapp_session_id?: string
          auto_accept_reservations?: boolean | null
        }
        Relationships: []
      }
      customers: {
        Row: {
          id: string
          phone: string
          name: string
          business_id: string
          created_at: string
          last_seen_at: string
        }
        Insert: {
          id?: string
          phone: string
          name: string
          business_id: string
          created_at?: string
          last_seen_at?: string
        }
        Update: {
          id?: string
          phone?: string
          name?: string
          business_id?: string
          created_at?: string
          last_seen_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          }
        ]
      }
      zones: {
        Row: {
          id: string
          business_id: string
          name: string
          priority: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          business_id: string
          name: string
          priority?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          business_id?: string
          name?: string
          priority?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "zones_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          }
        ]
      }
      tables: {
        Row: {
          id: string
          business_id: string
          zone_id: string
          table_number: string
          capacity: number
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          business_id: string
          zone_id: string
          table_number: string
          capacity: number
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          business_id?: string
          zone_id?: string
          table_number?: string
          capacity?: number
          is_active?: boolean
          created_at?: string
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
          {
            foreignKeyName: "tables_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          }
        ]
      }
      waitlist_entries: {
        Row: {
          id: string
          business_id: string
          customer_id: string
          party_size: number
          position: number
          display_code: string
          queued_at: string
          notified_at: string | null
          seated_at: string | null
          created_at: string
          updated_at: string
          status: string
          table_id: string | null
        }
        Insert: {
          id?: string
          business_id: string
          customer_id: string
          party_size: number
          position: number
          display_code: string
          queued_at?: string
          notified_at?: string | null
          seated_at?: string | null
          created_at?: string
          updated_at?: string
          status: string
          table_id?: string | null
        }
        Update: {
          id?: string
          business_id?: string
          customer_id?: string
          party_size?: number
          position?: number
          display_code?: string
          queued_at?: string
          notified_at?: string | null
          seated_at?: string | null
          created_at?: string
          updated_at?: string
          status?: string
          table_id?: string | null
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
          }
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
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (PublicSchema["Tables"] &
      PublicSchema["Views"])
  ? (PublicSchema["Tables"] &
      PublicSchema["Views"])[PublicTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
  ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
  ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof PublicSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema["Enums"]
  ? PublicSchema["Enums"][PublicEnumNameOrOptions]
  : never
